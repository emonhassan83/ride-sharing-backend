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
  lastNotifyHours: number; // continuous re-match window before departure
}> => {
  const settings = await Setting.find({
    key: { $in: ['matchingNoDriverNotifyHours', 'matchingLastNotifyHours'] },
  }).lean();

  const map: Record<string, number> = {};
  for (const s of settings) map[s.key] = Number(s.value);

  return {
    notifyHours: map.matchingNoDriverNotifyHours ?? 48, // fallback 48h
    lastNotifyHours: map.matchingLastNotifyHours ?? 24, // fallback 24h
  };
};

export const checkNoDriverFound = async () => {
  const redis = getRedisClient();
  const io = getIO();
  const now = new Date();

  const { notifyHours, lastNotifyHours } = await getMatchingSettings();
  const finalRematchHours = Math.max(lastNotifyHours, 24);
  const notifyThrottleSeconds = 5 * 60;
  const reNotifyBefore = new Date(now.getTime() + notifyHours * 3600000);
  const reNotifyBeforeLocal = `${reNotifyBefore.getFullYear()}-${String(reNotifyBefore.getMonth() + 1).padStart(2, '0')}-${String(reNotifyBefore.getDate()).padStart(2, '0')}`;
  const gracePeriodCutoff = new Date(now.getTime() - 30 * 1000);

  const pendingRides = await Ride.find({
    status: RIDE_STATUS.pending,
    departureDate: { $lte: reNotifyBeforeLocal },
    createdAt: { $lte: gracePeriodCutoff },
  })
    .limit(BATCH_SIZE)
    .lean();

  const cancelRideIds: string[] = [];

  for (const ride of pendingRides) {
    const departureDateTime = getDepartureDateTime(ride.departureDate, ride.departureTime);
    const hoursUntilDeparture = (departureDateTime.getTime() - now.getTime()) / 3600000;

    if (hoursUntilDeparture <= 0) {
      cancelRideIds.push(ride._id.toString());
      continue;
    }

    if (hoursUntilDeparture > notifyHours) continue;

    const isFinalContinuousWindow = hoursUntilDeparture <= finalRematchHours;
    const alreadyInitialRenotified = !!(ride as any).reNotifiedAt;
    if (!isFinalContinuousWindow && alreadyInitialRenotified) continue;

    const throttleKey = `ride:matching:renotify:${ride._id}`;
    if (isFinalContinuousWindow) {
      const recentlyChecked = await redis.get(throttleKey);
      if (recentlyChecked) continue;
    }

    const passenger = await Passenger.findOne({
      rideId: ride._id,
      status: PASSENGER_STATUS.pending,
    }).lean();

    if (!passenger) continue;

    const booking = await Booking.findOne({
      passengerId: passenger._id,
      rideId: ride._id,
      paymentStatus: { $in: [PAYMENT_STATUS.authorized, PAYMENT_STATUS.paid] },
    }).lean();
    if (!booking) {
      await redis.hset(`ride:request:${ride._id}`, {
        matchingStatus: 'awaiting_payment',
        lastCheckedAt: now.getTime().toString(),
      });
      continue;
    }

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
      bookingId: booking._id.toString(),
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
      reNotifiedAt: (ride as any).reNotifiedAt || now,
    });

    await redis.set(throttleKey, now.getTime().toString(), 'EX', notifyThrottleSeconds);
    await redis.hset(`ride:request:${ride._id}`, {
      bookingId: booking._id.toString(),
      notifiedCount: notified.toString(),
      matchingStatus: notified > 0
        ? (isFinalContinuousWindow ? 'continuous_renotified' : 'renotified')
        : (isFinalContinuousWindow ? 'continuous_matching_no_new_driver' : 'renotify_no_driver'),
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

  if (!cancelRideIds.length) return;

  // Bulk cancel rides only after pickup time has passed and no driver accepted.
  await Ride.updateMany(
    { _id: { $in: cancelRideIds }, status: RIDE_STATUS.pending },
    {
      status: RIDE_STATUS.cancelled,
      cancellationReason: 'no_driver_found',
      cancelledBy: CANCELLED_BY.system,
      cancelledAt: now,
    }
  );

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

        if (payment.providerEarning && payment.providerEarning > 0 && booking.driverId) {
          await User.findByIdAndUpdate(booking.driverId, {
            $inc: { wallet: -payment.providerEarning }
          });
        }
      }

      await Refund.create({
        user: booking.userId,
        ...(booking.rideId ? { ride: booking.rideId } : {}),
        type: REFUND_TYPE.cancel_ride,
        paymentIntentId: booking.transactionId || payment?.transactionId || '',
        amount: paidAmount,
        reason: 'No driver found',
        note: `Ride ${booking.rideId} cancelled due to no driver found`,
        status: REFUND_STATUS.confirmed,
      });

      booking.bookingStatus = BOOKING_STATUS.cancelled;
      booking.paymentStatus = PAYMENT_STATUS.refunded as any;
      booking.refundAmount = paidAmount;
      await booking.save();

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

  await Passenger.updateMany(
    { rideId: { $in: cancelRideIds }, status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.completed] } },
    {
      status: PASSENGER_STATUS.cancelled,
      cancellationReason: 'no_driver_found',
      cancelledBy: CANCELLED_BY.system,
    }
  );

  const cancelledPassengers = await Passenger.find(
    { rideId: { $in: cancelRideIds }, cancellationReason: 'no_driver_found' },
    'userId rideId'
  ).lean();

  for (const p of cancelledPassengers) {
    io.to(`user:${p.userId}`).emit('ride:no-driver-found', {
      rideId: p.rideId,
      message: 'No driver accepted your ride before pickup time. Booking has been cancelled.',
      retryAfter: 5,
    });

    const riderUser = await User.findById(p.userId).select('fcmToken').lean();
    if (riderUser?.fcmToken) {
      sendNotification([riderUser.fcmToken], {
        receiver: p.userId,
        message: 'Ride Cancelled � No Driver Found',
        description: `No driver accepted your ride before pickup time. Your booking has been cancelled.`,
        reference: p.rideId?.toString() || '',
        modelType: modeType.Ride,
      }).catch(() => {});
    }
  }

  const multi = redis.multi();
  for (const rideId of cancelRideIds) {
    multi.zrem('ride:matching:queue', rideId);
    multi.del(`ride:request:${rideId}`);
    multi.del(`ride:matching:renotify:${rideId}`);
  }
  await multi.exec();

  console.log(`?? No driver found after pickup: cancelled ${cancelRideIds.length} ride(s)`);
};

