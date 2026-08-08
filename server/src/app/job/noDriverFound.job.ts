// jobs/noDriverFound.job.ts
import { getRedisClient } from '../config/redis.config';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { Passenger } from '../modules/passenger/passenger.model';
import { CANCELLED_BY, RIDE_STATUS } from '../modules/ride/ride.constant';
import { Ride } from '../modules/ride/ride.model';
import { User } from '../modules/user/user.model';
import { Setting } from '../modules/settings/settings.model';
import { modeType } from '../modules/notification/notification.interface';
import { sendNotification } from '../utils/sentPushNotification';
import { notifyNearbyDrivers } from '../utils/notifyDrivers.utils';
import { getIO } from '../socket/socket.init';
import { Booking } from '../modules/booking/booking.model';
import { Payment } from '../modules/payment/payment.model';
import { Refund } from '../modules/refund/refund.model';
import { BOOKING_STATUS, PAYMENT_STATUS } from '../modules/booking/booking.constant';
import { REFUND_STATUS, REFUND_TYPE } from '../modules/refund/refund.constant';
import { refundToWallet } from '../utils/splitFare.utils';
import { getDepartureDateTime } from '../utils/rideSchedule.utils';
import Stripe from 'stripe';
import { config } from '../config/env.config';

const BATCH_SIZE = 50;

const stripe = new Stripe(config.pay?.secretKey as string, {
  apiVersion: '2026-06-24.dahlia',
  typescript: true,
});

// â”€â”€ Load settings with fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const getMatchingSettings = async (): Promise<{
  notifyHours: number; // re-notify X hours before departure
}> => {
  const settings = await Setting.find({
    key: { $in: ['matchingNoDriverNotifyHours'] },
  }).lean();

  const map: Record<string, number> = {};
  for (const s of settings) map[s.key] = Number(s.value);

  return {
    notifyHours: map.matchingNoDriverNotifyHours ?? 48, // fallback 48h
  };
};

export const checkNoDriverFound = async () => {
  const redis = getRedisClient();
  const io = getIO();
  const now = new Date();

  const { notifyHours } = await getMatchingSettings();

  // Phase 2: Re-notify drivers before pickup time. Do not cancel before pickup.
  const reNotifyBefore = new Date(now.getTime() + notifyHours * 3600000);
  const reNotifyBeforeLocal = `${reNotifyBefore.getFullYear()}-${String(reNotifyBefore.getMonth() + 1).padStart(2, '0')}-${String(reNotifyBefore.getDate()).padStart(2, '0')}`;
  const gracePeriodCutoff = new Date(now.getTime() - 30 * 60 * 1000);

  const ridesForRenotify = await Ride.find({
    status: RIDE_STATUS.pending,
    departureDate: { $lte: reNotifyBeforeLocal },
    reNotifiedAt: { $exists: false },
    createdAt: { $lte: gracePeriodCutoff },
  })
    .limit(BATCH_SIZE)
    .lean();

  for (const ride of ridesForRenotify) {
    const departureDateTime = getDepartureDateTime(
      ride.departureDate,
      ride.departureTime
    );
    const hoursUntilDeparture =
      (departureDateTime.getTime() - now.getTime()) / 3600000;

    if (hoursUntilDeparture > 0 && hoursUntilDeparture <= notifyHours) {
      const passenger = await Passenger.findOne({
        rideId: ride._id,
        status: PASSENGER_STATUS.pending,
      }).lean();

      if (!passenger) continue;

      const rider = await User.findById((ride as any).rideCreatedBy)
        .select('_id name profileImage')
        .lean();

      const ridePayload = {
        _id: passenger._id,
        userId: {
          _id: rider?._id || null,
          name: rider?.name || '',
          profileImage: rider?.profileImage || null,
        },
        rideId: {
          _id: ride._id,
          type: ride.type,
          id: (ride as any).id || '',
        },
        pickup: {
          address: ride.pickup.address,
          coordinates: ride.pickup.coordinates,
        },
        destination: {
          address: ride.destination.address,
          coordinates: ride.destination.coordinates,
        },
        departureDate: ride.departureDate,
        departureTime: ride.departureTime,
        rideType: ride.type,
        requestedSeats: (passenger as any).requestedSeats || 1,
        estimatedFare: (passenger as any).estimatedFare || 0,
        estimatedDistanceKm: (passenger as any).estimatedDistanceKm || 0,
        estimatedDurationMinutes: (passenger as any).estimatedDurationMinutes || 0,
        status: PASSENGER_STATUS.pending,
        createdAt: (passenger as any).createdAt,
      };

      const notified = await notifyNearbyDrivers(
        ride._id.toString(),
        { lat: ride.pickup.coordinates[1], lng: ride.pickup.coordinates[0] },
        ridePayload,
        redis,
        io,
        passenger._id.toString(),
        10,
        undefined,
        { notifyMode: 'all_eligible' }
      );

      await Ride.findByIdAndUpdate(ride._id, {
        reNotifiedAt: now,
      });

      await redis.hset(`ride:request:${ride._id}`, {
        notifiedCount: notified.toString(),
        matchingStatus: notified > 0 ? 'renotified' : 'renotify_no_driver',
        lastNotifiedAt: now.getTime().toString(),
      });

      const riderUser = await User.findById((ride as any).rideCreatedBy)
        .select('fcmToken')
        .lean();

      io.to(`user:${(ride as any).rideCreatedBy}`).emit('ride:re-matching', {
        rideId: ride._id,
        message: `We're still looking for a driver. ${notified} driver(s) notified.`,
      });

      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver: (ride as any).rideCreatedBy,
          message: 'Still Searching for a Driver',
          description: `We're still trying to find a driver for your ride. ${notified} driver(s) have been notified.`,
          reference: ride._id.toString(),
          modelType: modeType.Ride,
        }).catch(() => {});
      }
    }
  }

  // Phase 3: Cancel only after pickup time has passed and no driver accepted
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const ridesForCancel = await Ride.find({
    status: RIDE_STATUS.pending,
    departureDate: { $lte: todayLocal },
  })
    .limit(BATCH_SIZE)
    .lean();

  const cancelRideIds: string[] = [];

  for (const ride of ridesForCancel) {
    const departureDateTime = getDepartureDateTime(
      ride.departureDate,
      ride.departureTime
    );

    if (departureDateTime.getTime() <= now.getTime()) {
      cancelRideIds.push(ride._id.toString());
    }
  }

  if (!cancelRideIds.length) return;

  // Bulk cancel rides
  await Ride.updateMany(
    { _id: { $in: cancelRideIds }, status: RIDE_STATUS.pending },
    {
      status: RIDE_STATUS.cancelled,
      cancellationReason: 'no_driver_found',
      cancelledBy: CANCELLED_BY.system,
      cancelledAt: now,
    }
  );

  // Query and refund bookings first
  const bookingsToRefund = await Booking.find({
    rideId: { $in: cancelRideIds },
    bookingStatus: { $ne: BOOKING_STATUS.cancelled },
  });

  for (const booking of bookingsToRefund) {
    const payment = await Payment.findOne({ booking: booking._id });

    if (payment?.status === PAYMENT_STATUS.authorized && payment.paymentIntentId) {
      try {
        const intent = await stripe.paymentIntents.retrieve(payment.paymentIntentId);
        if (intent.status === 'requires_capture') {
          await stripe.paymentIntents.cancel(payment.paymentIntentId);
        }
      } catch (error: any) {
        console.error('Failed to cancel authorized payment:', error.message);
      }

      payment.status = PAYMENT_STATUS.cancelled_authorization as any;
      payment.isPaid = false;
      await payment.save();

      booking.bookingStatus = BOOKING_STATUS.cancelled;
      booking.paymentStatus = PAYMENT_STATUS.cancelled_authorization as any;
      booking.amountPaid = 0;
      await booking.save();
      continue;
    }

    const paidAmount = booking.amountPaid ?? 0;
    if (paidAmount > 0) {
      if (payment && payment.status === PAYMENT_STATUS.paid) {
        payment.status = PAYMENT_STATUS.refunded as any;
        payment.isPaid = false;
        await payment.save();

        // Deduct from driver's wallet if driver was somehow assigned and paid
        if (payment.providerEarning && payment.providerEarning > 0 && booking.driverId) {
          await User.findByIdAndUpdate(booking.driverId, {
            $inc: { wallet: -payment.providerEarning }
          });
        }
      }

      // Create Refund record
      await Refund.create({
        user: booking.userId,
        ride: booking.rideId,
        type: REFUND_TYPE.cancel_ride,
        paymentIntentId: booking.transactionId || payment?.transactionId || '',
        amount: paidAmount,
        reason: 'No driver found',
        note: `Ride ${booking.rideId} cancelled due to no driver found`,
        status: REFUND_STATUS.confirmed,
      });

      // Update Booking
      booking.bookingStatus = BOOKING_STATUS.cancelled;
      booking.paymentStatus = PAYMENT_STATUS.refunded as any;
      booking.refundAmount = paidAmount;
      await booking.save();

      // Refund user
      await refundToWallet(
        booking.userId.toString(),
        paidAmount,
        'no_driver_found',
        io
      );
    } else {
      booking.bookingStatus = BOOKING_STATUS.cancelled;
      await booking.save();
    }
  }

  // Bulk cancel passengers
  await Passenger.updateMany(
    { rideId: { $in: cancelRideIds }, status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.completed] } },
    {
      status: PASSENGER_STATUS.cancelled,
      cancellationReason: 'no_driver_found',
      cancelledBy: CANCELLED_BY.system,
    }
  );

  // Notify riders â€” cancelled
  const cancelledPassengers = await Passenger.find(
    { rideId: { $in: cancelRideIds }, cancellationReason: 'no_driver_found' },
    'userId rideId'
  ).lean();

  for (const p of cancelledPassengers) {
    // Socket
    io.to(`user:${p.userId}`).emit('ride:no-driver-found', {
      rideId: p.rideId,
      message: 'No driver accepted your ride. Booking has been cancelled.',
      retryAfter: 5,
    });

    // âœ… FCM push â€” no driver found, cancelled
    const riderUser = await User.findById(p.userId).select('fcmToken').lean();
    if (riderUser?.fcmToken) {
      sendNotification([riderUser.fcmToken], {
        receiver: p.userId,
        message: 'Ride Cancelled â€” No Driver Found',
        description: `No driver was available for your ride. Your booking has been cancelled.`,
        reference: p.rideId.toString(),
        modelType: modeType.Ride,
      }).catch(() => {});
    }
  }

  // Redis cleanup
  const multi = redis.multi();
  for (const rideId of cancelRideIds) {
    multi.zrem('ride:matching:queue', rideId);
    multi.del(`ride:request:${rideId}`);
  }
  await multi.exec();

  console.log(`ðŸš« No driver found: cancelled ${cancelRideIds.length} ride(s)`);
};



