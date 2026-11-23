// jobs/noDriverFound.job.ts
import { getRedisClient } from '../config/redis.config';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { Passenger } from '../modules/passenger/passenger.model';
import { CANCELLED_BY, RIDE_STATUS } from '../modules/ride/ride.constant';
import { Ride } from '../modules/ride/ride.model';
import { User } from '../modules/user/user.model';
import { revertDriverEarningIfCredited } from '../utils/driverEarning.utils';
import { Setting } from '../modules/settings/settings.model';
import { modeType } from '../modules/notification/notification.interface';
import { notifyUserPush } from '../utils/notifyUser.utils';
import {
  notifyNearbyDrivers,
  notifyRiderDriversNotified,
} from '../utils/notifyDrivers.utils';
import { getIO } from '../socket/socket.init';
import { Booking } from '../modules/booking/booking.model';
import { Payment } from '../modules/payment/payment.model';
import { Refund } from '../modules/refund/refund.model';
import { BOOKING_STATUS, PAYMENT_STATUS } from '../modules/booking/booking.constant';
import { REFUND_STATUS, REFUND_TYPE } from '../modules/refund/refund.constant';
import { refundToWallet } from '../utils/splitFare.utils';
import { PaymentService } from '../modules/payment/payment.service';
import { formatRideLocalDate, getDepartureDateTime } from '../utils/rideSchedule.utils';
import { toLuggageFyiView } from '../utils/luggage.utils';
import Stripe from 'stripe';
import { config } from '../config/env.config';

const BATCH_SIZE = 50;

const stripe = new Stripe(config.pay?.secretKey as string, {
  apiVersion: '2026-06-24.dahlia',
  typescript: true,
});

// Load settings with fallback
const getMatchingSettings = async (): Promise<{
  notifyHours: number;
  lastNotifyHours: number;
  renotifyIntervalMinutes: number;
}> => {
  const settings = await Setting.find({
    key: {
      $in: [
        'matchingNoDriverNotifyHours',
        'matchingLastNotifyHours',
        'waitingReminderIntervals',
      ],
    },
  }).lean();

  const map: Record<string, number> = {};
  for (const s of settings) map[s.key] = Number(s.value);

  return {
    notifyHours: map.matchingNoDriverNotifyHours ?? 48,
    lastNotifyHours: map.matchingLastNotifyHours ?? 24,
    renotifyIntervalMinutes: map.waitingReminderIntervals ?? 10,
  };
};

/**
 * B-13: a rider who joined a split ride the driver had ALREADY accepted stays
 * "pending" until the driver accepts them too. The pass below only looks at
 * unassigned pending rides, so if pickup passed without that, the rider was
 * never cancelled or refunded and never appeared in History → Cancelled.
 */
const expireUnacceptedPassengersOnAssignedRides = async (io: any, now: Date) => {
  const today = formatRideLocalDate(now);
  const candidates = await Passenger.find({
    status: PASSENGER_STATUS.pending,
    rideId: { $ne: null },
    departureDate: { $lte: today },
  })
    .select('_id userId rideId departureDate departureTime')
    .sort({ departureDate: 1, departureTime: 1 })
    .limit(BATCH_SIZE)
    .lean();

  for (const p of candidates) {
    try {
      if (getDepartureDateTime(p.departureDate as any, p.departureTime as any).getTime() > now.getTime()) {
        continue;
      }
      const ride = await Ride.findById(p.rideId).select('status driverId').lean();
      // Unassigned pending rides are handled by the main pass below. Everything
      // else (accepted/started, or a ride already cancelled/completed that left
      // this rider "pending") is expired here. The refund claim is atomic, so
      // money already refunded by another path is never refunded twice.
      if (ride && ride.status === RIDE_STATUS.pending && !ride.driverId) continue;

      const claimed = await Passenger.findOneAndUpdate(
        { _id: p._id, status: PASSENGER_STATUS.pending },
        {
          status: PASSENGER_STATUS.cancelled,
          cancellationReason: 'no_driver_found',
          cancelledBy: CANCELLED_BY.system,
        },
      );
      if (!claimed) continue;

      let refundAmount = 0;
      let released = false;
      const booking = await Booking.findOne({ passengerId: p._id });
      if (booking) {
        released = await PaymentService.cancelAuthorizedBookingPayment(booking._id.toString());
        const claimedPayment = await Payment.findOneAndUpdate(
          { booking: booking._id, status: PAYMENT_STATUS.paid, isPaid: true },
          { $set: { status: PAYMENT_STATUS.refunded, isPaid: false } },
          { returnDocument: 'after' },
        );
        if (claimedPayment) {
          refundAmount = Math.round(Number(booking.amountPaid || claimedPayment.amount || 0) * 100) / 100;
          await refundToWallet(booking.userId.toString(), refundAmount, 'no_driver_found', io);
          await Refund.create({
            user: booking.userId,
            ride: p.rideId,
            type: REFUND_TYPE.cancel_ride,
            paymentIntentId: booking.transactionId || claimedPayment.transactionId || '',
            amount: refundAmount,
            reason: 'No driver found',
            note: `Passenger ${String(p._id)} was not accepted before pickup`,
            status: REFUND_STATUS.confirmed,
          });
        }
        await Booking.updateOne(
          { _id: booking._id },
          {
            $set: {
              bookingStatus: BOOKING_STATUS.cancelled,
              ...(refundAmount > 0 ? { paymentStatus: PAYMENT_STATUS.refunded, refundAmount } : {}),
            },
          },
        );
      }

      const userId = String(p.userId || '');
      if (!userId) continue;
      const description =
        refundAmount > 0
          ? `No driver accepted your ride before pickup time. Your booking has been cancelled and €${refundAmount.toFixed(2)} has been refunded to your wallet.`
          : released
            ? 'No driver accepted your ride before pickup time. Your booking has been cancelled and the payment hold on your card has been released.'
            : 'No driver accepted your ride before pickup time. Your booking has been cancelled.';
      io.to(`user:${userId}`).emit('ride:no-driver-found', {
        rideId: p.rideId,
        passengerId: p._id,
        refundAmount,
        paymentReleased: released,
        cancellationReason: 'no_driver_found',
        message: description,
      });
      await notifyUserPush({
        userId,
        message: 'Ride Cancelled — No Driver Found',
        description,
        reference: String(p.rideId),
        modelType: modeType.Ride,
        dedupeKey: `no-driver-cancelled:${String(p.rideId)}:${String(p._id)}`,
        data: {
          type: 'RIDE_CANCELLED_NO_DRIVER',
          rideId: String(p.rideId),
          passengerId: String(p._id),
          refundAmount: String(refundAmount),
          screen: 'ride_details',
        },
      });
    } catch (error: any) {
      console.error(`Expiring unaccepted passenger ${String(p._id)} failed:`, error?.message || error);
    }
  }
};

export const checkNoDriverFound = async () => {
  const redis = getRedisClient();
  const io = getIO();
  const now = new Date();

  await expireUnacceptedPassengersOnAssignedRides(io, now).catch((err: any) =>
    console.error('expireUnacceptedPassengersOnAssignedRides failed:', err?.message || err),
  );

  const { notifyHours, lastNotifyHours, renotifyIntervalMinutes } =
    await getMatchingSettings();
  const finalRematchHours = lastNotifyHours;
  const notifyThrottleSeconds = Math.max(renotifyIntervalMinutes, 1) * 60;
  const reNotifyBefore = new Date(now.getTime() + notifyHours * 3600000);
  const reNotifyBeforeLocal = formatRideLocalDate(reNotifyBefore);
  const gracePeriodCutoff = new Date(now.getTime() - 30 * 1000);

  const pendingRides = await Ride.find({
    status: RIDE_STATUS.pending,
    $or: [{ driverId: { $exists: false } }, { driverId: null }],
    departureDate: { $lte: reNotifyBeforeLocal },
    createdAt: { $lte: gracePeriodCutoff },
  })
    // B-12: rides closest to (or past) pickup first, so an expired ride is never
    // pushed out of the batch by rides that are still days away.
    .sort({ departureDate: 1, departureTime: 1 })
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
    const recentlyChecked = await redis.get(throttleKey);
    if (recentlyChecked) continue;

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
      vehicleType: (ride as any).vehicleType || null,
      requestedSeats: (passenger as any).requestedSeats || 1,
      estimatedFare: (passenger as any).estimatedFare || 0,
      estimatedDistanceKm: (passenger as any).estimatedDistanceKm || 0,
      estimatedDurationMinutes: (passenger as any).estimatedDurationMinutes || 0,
      status: PASSENGER_STATUS.pending,
      bookingId: booking._id.toString(),
      // B-15: same public references the rider sees.
      bookingShortId: (booking as any).id || null,
      rideShortId: (ride as any).id || null,
      createdAt: (passenger as any).createdAt,
      ...toLuggageFyiView(passenger),
    };

    const notified = await notifyNearbyDrivers(
      ride._id.toString(),
      { lat: ride.pickup.coordinates[1], lng: ride.pickup.coordinates[0] },
      ridePayload,
      redis,
      io,
      passenger._id.toString(),
      10,
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

    // Tell every waiting rider on this ride (not only rideCreatedBy — on a
    // peer-matched split ride that is just the host) how many drivers have it.
    // Previously: push only when NEW drivers were found, so with the same
    // nearby drivers the rider heard nothing at rematch time.
    const waitingRiders = await Passenger.find({
      rideId: ride._id,
      status: PASSENGER_STATUS.pending,
    })
      .select('_id userId')
      .lean();

    for (const rider of waitingRiders) {
      const riderId = rider.userId?.toString();
      if (!riderId) continue;

      const total = await notifyRiderDriversNotified({
        io,
        userId: riderId,
        rideId: ride._id.toString(),
        passengerId: rider._id.toString(),
        newlyNotified: notified,
        variant: 'rematch',
        rematchStage: isFinalContinuousWindow ? 'final' : 'initial',
      });

      // Legacy event kept for older app builds.
      io.to(`user:${riderId}`).emit('ride:re-matching', {
        rideId: ride._id,
        notifiedDrivers: total,
        message: `We're still looking for a driver. ${total} ${total === 1 ? 'driver' : 'drivers'} notified.`,
      });
    }
  }

  if (!cancelRideIds.length) return;

  // Filter out any ride that was accepted by a driver or already has confirmed passengers
  const trulyUnassignedRides = await Ride.find({
    _id: { $in: cancelRideIds },
    status: RIDE_STATUS.pending,
    $or: [{ driverId: { $exists: false } }, { driverId: null }],
  })
    .select('_id')
    .lean();

  const confirmedRideIds = await Passenger.distinct('rideId', {
    rideId: { $in: trulyUnassignedRides.map((r) => r._id) },
    status: {
      $in: [
        PASSENGER_STATUS.confirmed,
        PASSENGER_STATUS.driver_arrived,
        PASSENGER_STATUS.in_progress,
        PASSENGER_STATUS.picked_up,
        PASSENGER_STATUS.completed,
      ],
    },
  });
  const confirmedSet = new Set(confirmedRideIds.map((id: any) => String(id)));
  const candidateCancelRideIds = trulyUnassignedRides
    .map((r) => r._id.toString())
    .filter((id) => !confirmedSet.has(id));

  if (!candidateCancelRideIds.length) return;

  // Claim each ride atomically: only the run that actually flips it to
  // cancelled refunds and notifies. The old bulk updateMany didn't check the
  // result, so an overlapping run (or a second server instance on the same
  // DB) re-sent "Ride Cancelled — No Driver Found" to the same rider.
  const finalCancelRideIds: string[] = [];
  for (const rideId of candidateCancelRideIds) {
    const claimed = await Ride.findOneAndUpdate(
      {
        _id: rideId,
        status: RIDE_STATUS.pending,
        $or: [{ driverId: { $exists: false } }, { driverId: null }],
      },
      {
        status: RIDE_STATUS.cancelled,
        cancellationReason: 'no_driver_found',
        cancelledBy: CANCELLED_BY.system,
        cancelledAt: now,
      },
      { projection: { _id: 1 } },
    ).lean();
    if (claimed) finalCancelRideIds.push(rideId);
  }

  if (!finalCancelRideIds.length) return;

  const bookingsToRefund = await Booking.find({
    rideId: { $in: finalCancelRideIds },
    bookingStatus: { $nin: [BOOKING_STATUS.cancelled, BOOKING_STATUS.completed] },
  });

  // B-12: remember what happened to each rider's money so the "no driver found"
  // push can say it (refunded to wallet / card hold released). Keyed by ride + rider.
  const outcomeByPassenger = new Map<string, { refundAmount: number; released: boolean }>();

  for (const booking of bookingsToRefund) {
    // Each booking is handled on its own: one failure must not stop the other riders' refunds.
    try {
      const payment = await Payment.findOne({ booking: booking._id });

      if (payment?.status === PAYMENT_STATUS.authorized && payment.paymentIntentId) {
        try {
          const intent = await stripe.paymentIntents.retrieve(payment.paymentIntentId);
          if (intent.status === 'requires_capture') {
            await stripe.paymentIntents.cancel(payment.paymentIntentId);
          }
        } catch (error: any) {
          // The hold may still be on the rider's card, so do not record it as released.
          console.error('Failed to cancel authorized payment:', error.message);
          continue;
        }

        payment.status = PAYMENT_STATUS.cancelled_authorization as any;
        payment.isPaid = false;
        await payment.save();

        booking.bookingStatus = BOOKING_STATUS.cancelled;
        booking.paymentStatus = PAYMENT_STATUS.cancelled_authorization as any;
        booking.amountPaid = 0;
        await booking.save();
        outcomeByPassenger.set(`${String(booking.rideId)}:${String(booking.userId)}`, { refundAmount: 0, released: true });
        continue;
      }

      const paidAmount = booking.amountPaid ?? 0;
      if (paidAmount > 0) {
        // Credit the rider first: the booking is only finalised as refunded once the money is back.
        await refundToWallet(
          booking.userId.toString(),
          paidAmount,
          'no_driver_found',
          io
        );

        if (payment && payment.status === PAYMENT_STATUS.paid) {
          payment.status = PAYMENT_STATUS.refunded as any;
          payment.isPaid = false;
          await payment.save();

          // Only reverses money the driver was actually credited (at completion).
          await revertDriverEarningIfCredited({
            rideId: booking.rideId,
            driverId: booking.driverId,
            amount: payment.providerEarning,
          });
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
        outcomeByPassenger.set(`${String(booking.rideId)}:${String(booking.userId)}`, { refundAmount: paidAmount, released: false });
      } else {
        booking.bookingStatus = BOOKING_STATUS.cancelled;
        await booking.save();
      }
    } catch (error: any) {
      console.error(
        `No-driver refund failed for booking ${String(booking._id)}:`,
        error?.message || error,
      );
    }
  }

  await Passenger.updateMany(
    { rideId: { $in: finalCancelRideIds }, status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.completed] } },
    {
      status: PASSENGER_STATUS.cancelled,
      cancellationReason: 'no_driver_found',
      cancelledBy: CANCELLED_BY.system,
    }
  );

  const cancelledPassengers = await Passenger.find(
    { rideId: { $in: finalCancelRideIds }, cancellationReason: 'no_driver_found' },
    '_id userId rideId'
  ).lean();

  const ridesToRemove = pendingRides.filter((ride) =>
    finalCancelRideIds.includes(ride._id.toString()),
  );
  for (const ride of ridesToRemove) {
    const driverIds = new Set<string>(
      ((ride as any).notifiedDriverIds || []).map((id: any) => id.toString()),
    );
    if ((ride as any).driverId) driverIds.add((ride as any).driverId.toString());

    for (const driverId of driverIds) {
      io.to(`driver:${driverId}`).emit('ride:request-removed', {
        rideId: ride._id,
        reason: 'pickup_time_no_accept',
        message: 'Ride request expired. Pickup time passed with no driver accepted.',
      });
    }
  }

  for (const p of cancelledPassengers) {
    const userId = p.userId?.toString();
    if (!userId) continue;

    const outcome = outcomeByPassenger.get(`${String(p.rideId)}:${String(p.userId)}`);
    const refundAmount = outcome?.refundAmount || 0;
    const description =
      refundAmount > 0
        ? `No driver accepted your ride before pickup time. Your booking has been cancelled and €${refundAmount.toFixed(2)} has been refunded to your wallet.`
        : outcome?.released
          ? 'No driver accepted your ride before pickup time. Your booking has been cancelled and the payment hold on your card has been released.'
          : 'No driver accepted your ride before pickup time. Your booking has been cancelled.';

    io.to(`user:${userId}`).emit('ride:no-driver-found', {
      rideId: p.rideId,
      passengerId: p._id,
      refundAmount,
      paymentReleased: !!outcome?.released,
      cancellationReason: 'no_driver_found',
      message: description,
      retryAfter: 5,
    });

    await notifyUserPush({
      userId,
      message: 'Ride Cancelled — No Driver Found',
      description,
      reference: p.rideId?.toString() || '',
      modelType: modeType.Ride,
      dedupeKey: `no-driver-cancelled:${String(p.rideId || '')}`,
      data: {
        type: 'RIDE_CANCELLED_NO_DRIVER',
        rideId: String(p.rideId || ''),
        passengerId: String(p._id),
        refundAmount: String(refundAmount),
        screen: 'ride_details',
      },
    });
  }

  const multi = redis.multi();
  for (const rideId of finalCancelRideIds) {
    multi.zrem('ride:matching:queue', rideId);
    multi.del(`ride:request:${rideId}`);
    multi.del(`ride:matching:renotify:${rideId}`);
  }
  await multi.exec();

  console.log(`?? No driver found after pickup: cancelled ${finalCancelRideIds.length} ride(s)`);
};

