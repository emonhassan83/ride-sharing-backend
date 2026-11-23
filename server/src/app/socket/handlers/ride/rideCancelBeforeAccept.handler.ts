// handlers/ride/rideCancelBeforeAccept.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, CANCELLED_BY, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { PaymentService } from '../../../modules/payment/payment.service';
import { modeType } from '../../../modules/notification/notification.interface';
import { notifyUserPush } from '../../../utils/notifyUser.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { transferRideOwnership, refundToWallet } from '../../../utils/splitFare.utils';
import { Payment } from '../../../modules/payment/payment.model';
import { Refund } from '../../../modules/refund/refund.model';
import { revertDriverEarningIfCredited } from '../../../utils/driverEarning.utils';
import { BOOKING_STATUS, PAYMENT_STATUS } from '../../../modules/booking/booking.constant';
import { REFUND_STATUS, REFUND_TYPE } from '../../../modules/refund/refund.constant';

const notifyDriverCancelled = async (
  io: any,
  ride: { driverId?: any; notifiedDriverIds?: any[] },
  rideId: string,
  message: string,
  extra?: Record<string, any>,
) => {
  const driverIds = new Set<string>();
  if (ride.driverId) driverIds.add(ride.driverId.toString());
  for (const id of ride.notifiedDriverIds || []) {
    if (id) driverIds.add(id.toString());
  }
  if (!driverIds.size) return;

  const payload = { rideId, message, ...extra };
  await Promise.all(
    [...driverIds].map(async (id) => {
      io.to(`driver:${id}`).to(`user:${id}`).emit('ride:cancelled-by-rider', payload);
      await notifyUserPush({
        userId: id,
        message: 'Ride Cancelled by Rider',
        description: message,
        reference: rideId,
        modelType: modeType.Ride,
        data: { type: 'RIDE_CANCELLED_BY_RIDER', rideId: String(rideId) },
      });
    }),
  );
};

// A pending ride's card is only pre-authorised; release that hold when the rider leaves the ride.
// A wallet payment, though, is taken in full before any driver accepts. The old code only
// released card holds, so a rider who paid from the wallet and cancelled lost the money,
// and the booking was never marked cancelled (it then blocked account deletion, issue 30).
type TReleaseResult = { refundAmount: number; holdReleased: boolean };

const releaseAuthorizedHold = async (passengerId: any): Promise<TReleaseResult> => {
  const booking = await Booking.findOne({ passengerId });
  if (!booking) return { refundAmount: 0, holdReleased: false };

  const holdReleased = await PaymentService.cancelAuthorizedBookingPayment(booking._id.toString());

  // Atomic claim on the paid payment: a double tap cannot refund twice.
  const claimedPayment = await Payment.findOneAndUpdate(
    { booking: booking._id, status: PAYMENT_STATUS.paid, isPaid: true },
    { $set: { status: PAYMENT_STATUS.refunded, isPaid: false } },
    { returnDocument: 'after' },
  );

  let refundAmount = 0;
  if (claimedPayment) {
    refundAmount = Math.round(Number(booking.amountPaid || claimedPayment.amount || 0) * 100) / 100;
    try {
      await refundToWallet(booking.userId.toString(), refundAmount, 'cancel_before_accept', getIO());
    } catch (error) {
      // Money did not move: put the payment back so the cancel can be retried.
      await Payment.updateOne(
        { _id: claimedPayment._id },
        { $set: { status: PAYMENT_STATUS.paid, isPaid: true } },
      );
      throw error;
    }

    // Only reverses money the driver was actually credited (at completion).
    await revertDriverEarningIfCredited({
      rideId: booking.rideId,
      driverId: booking.driverId,
      amount: claimedPayment.providerEarning,
    });

    await Refund.create({
      user: booking.userId,
      ...(booking.rideId ? { ride: booking.rideId } : {}),
      type: REFUND_TYPE.cancel_ride,
      paymentIntentId: booking.transactionId || claimedPayment.transactionId || '',
      amount: refundAmount,
      reason: 'Cancelled by rider before acceptance',
      note: `Booking ${String(booking._id)} cancelled before a driver accepted`,
      status: REFUND_STATUS.confirmed,
    });
  }

  await Booking.updateOne(
    { _id: booking._id },
    {
      $set: {
        bookingStatus: BOOKING_STATUS.cancelled,
        ...(claimedPayment
          ? { paymentStatus: PAYMENT_STATUS.refunded, refundAmount }
          : {}),
      },
    },
  );

  return { refundAmount, holdReleased };
};

// B-11: the rider who cancelled used to get no confirmation at all (no socket
// event, no push), so the app had nothing telling it the money came back.
const notifyRiderOwnCancellation = async (
  io: any,
  userId: string,
  rideId: string,
  passengerId: string,
  result: TReleaseResult,
  cancelInfo: Record<string, unknown>,
) => {
  const description =
    result.refundAmount > 0
      ? `Your ride has been cancelled. €${result.refundAmount.toFixed(2)} has been refunded to your wallet.`
      : result.holdReleased
        ? 'Your ride has been cancelled. The payment hold on your card has been released.'
        : 'Your ride has been cancelled.';

  // The fee fields are also in the ack. They are repeated here because the event
  // arrives before the ack (the ack waits for the driver notifications) and some
  // clients emit without an ack callback.
  io.to(`user:${userId}`).emit('ride:cancelled', {
    rideId,
    passengerId,
    cancelledBy: CANCELLED_BY.user,
    ...cancelInfo,
    refundAmount: result.refundAmount,
    paymentReleased: result.holdReleased,
    message: description,
  });

  try {
    await notifyUserPush({
      userId,
      message: 'Ride Cancelled',
      description,
      reference: rideId,
      modelType: modeType.Ride,
      dedupeKey: `rider-cancelled:${passengerId}`,
      data: {
        type: 'RIDE_CANCELLED_BY_RIDER',
        rideId: String(rideId),
        passengerId: String(passengerId),
        refundAmount: String(result.refundAmount),
        screen: 'ride_details',
      },
    });
  } catch (err: any) {
    console.warn('Rider cancellation push failed:', err?.message || err);
  }
};

const cancelAndNotifyRemaining = async (
  io: any,
  rideId: string,
  remaining: Array<{ _id: any; userId: any }>,
  reason: string,
) => {
  for (const p of remaining) {
    await releaseAuthorizedHold(p._id);

    await Passenger.findByIdAndUpdate(p._id, {
      status: PASSENGER_STATUS.cancelled,
      cancellationReason: reason,
      cancelledBy: CANCELLED_BY.user,
    });

    const userId = p.userId?.toString();
    if (!userId) continue;

    io.to(`user:${userId}`).emit('ride:cancelled', {
      rideId,
      message: 'Ride was cancelled because not enough passengers remained.',
    });

    await notifyUserPush({
      userId,
      message: 'Ride Cancelled',
      description: 'Ride was cancelled because not enough passengers remained.',
      reference: rideId,
      modelType: modeType.Ride,
      data: { type: 'RIDE_CANCELLED', rideId: String(rideId) },
    });
  }
};

export const rideCancelBeforeAcceptHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, reason = '' } = data;
    const userId = socket.auth?._id?.toString();

    if (!rideId || !userId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });
    if (ride.status !== RIDE_STATUS.pending) {
      const driverAccepted = [RIDE_STATUS.accepted, RIDE_STATUS.started].includes(ride.status as any);
      return callback?.({
        success: false,
        message: driverAccepted
          ? 'Cannot cancel: driver already accepted'
          : 'Ride already accepted or cancelled',
      });
    }

    const passenger = await Passenger.findOne({ rideId, userId, status: PASSENGER_STATUS.pending });
    if (!passenger)
      return callback?.({ success: false, message: 'No pending booking found' });

    const redis = getRedisClient();
    const io    = getIO();

    // Release the card hold before recording the cancellation, so a failure stays retryable.
    const releaseResult = await releaseAuthorizedHold(passenger._id);
    // B-04: cancelling before acceptance is free; say so explicitly in every ack.
    const cancelInfo = {
      refundAmount: releaseResult.refundAmount,
      feeAmount: 0,
      feePercent: 0,
      refundDestination: releaseResult.refundAmount > 0 ? 'wallet' : releaseResult.holdReleased ? 'card_release' : null,
    };

    // Atomic: on a double tap only one request goes on to cancel the ride and notify.
    const claimed = await Passenger.findOneAndUpdate(
      { _id: passenger._id, status: PASSENGER_STATUS.pending },
      {
        status:             PASSENGER_STATUS.cancelled,
        cancellationReason: reason || 'Cancelled by rider',
        cancelledBy:        CANCELLED_BY.user,
      },
    );
    if (!claimed)
      return callback?.({ success: false, message: 'No pending booking found' });

    try {
      await redis.del(`ride:request:${rideId}:${passenger._id}`);
    } catch {
      /* best effort: the key also expires on its own */
    }
    await notifyRiderOwnCancellation(
      io,
      userId,
      rideId,
      passenger._id.toString(),
      releaseResult,
      cancelInfo,
    );

    const redisCleanup = async () => {
      await Promise.all([
        redis.zrem('ride:matching:queue', rideId),
        redis.del(`ride:request:${rideId}`),
        redis.del(`ride:matching:renotify:${rideId}`),
      ]);
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.cancelled,
        cancellationReason: reason || 'Cancelled by rider',
        cancelledBy: CANCELLED_BY.user, cancelledAt: new Date(),
      });
      await redisCleanup();
      await notifyDriverCancelled(
        io,
        ride,
        rideId,
        'Rider cancelled before acceptance.',
        { rideCancelled: true },
      );
      return callback?.({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true, ...cancelInfo } });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────
    if (ride.rideCreatedBy?.toString() === userId) {
      const remainingAfterCreator = await Passenger.find({
        rideId,
        _id: { $ne: passenger._id },
        status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
      }).select('_id userId');

      if (remainingAfterCreator.length <= 1) {
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: remainingAfterCreator.length === 0
            ? 'Creator cancelled before acceptance'
            : 'Creator cancelled, only one passenger remaining. Ride cancelled.',
          cancelledBy: CANCELLED_BY.user, cancelledAt: new Date(),
        });
        await redisCleanup();
        await cancelAndNotifyRemaining(
          io,
          rideId,
          remainingAfterCreator,
          'Only one passenger remaining. Ride cancelled.',
        );
        await notifyDriverCancelled(
          io,
          ride,
          rideId,
          remainingAfterCreator.length === 0
            ? 'All passengers cancelled.'
            : 'Only one passenger remaining. Ride cancelled.',
          { rideCancelled: true },
        );
        return callback?.({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true, ...cancelInfo } });
      }

      const transferred = await transferRideOwnership(rideId, userId, io);
      if (!transferred) {
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: 'Creator cancelled before acceptance',
          cancelledBy: CANCELLED_BY.user, cancelledAt: new Date(),
        });
        await redisCleanup();
        await notifyDriverCancelled(io, ride, rideId, 'All passengers cancelled.', {
          rideCancelled: true,
        });
        return callback?.({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true, ...cancelInfo } });
      }
    }

    // Decrement seats
    const updatedRide = await Ride.findByIdAndUpdate(
      rideId,
      { $inc: { bookedSeats: -(passenger.requestedSeats || 1) } },
      { returnDocument: 'after' },
    ).lean();

    const remaining = await Passenger.find({
      rideId,
      _id: { $ne: passenger._id },
      status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
    }).select('_id userId');

    if (remaining.length <= 1) {
      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.cancelled,
        cancellationReason: remaining.length === 0
          ? 'Last passenger cancelled'
          : 'Only one passenger remaining. Ride cancelled.',
        cancelledBy: CANCELLED_BY.user, cancelledAt: new Date(),
      });
      await redisCleanup();
      await cancelAndNotifyRemaining(
        io,
        rideId,
        remaining,
        'Only one passenger remaining. Ride cancelled.',
      );
      await notifyDriverCancelled(io, ride, rideId, 'All passengers cancelled.', {
        rideCancelled: true,
      });
      return callback?.({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true, ...cancelInfo } });
    }

    const remainingSeats = (updatedRide?.totalSeats ?? 0) - (updatedRide?.bookedSeats ?? 0);

    await notifyDriverCancelled(
      io,
      ride,
      rideId,
      'A passenger cancelled before driver acceptance.',
      {
        rideCancelled: false,
        passengerId: passenger._id,
        remainingSeats,
      },
    );

    for (const p of remaining) {
      const coUserId = p.userId?.toString();
      if (!coUserId) continue;

      io.to(`user:${coUserId}`).emit('ride:co-passenger-cancelled', {
        rideId, cancelledPassengerId: passenger._id, remainingSeats,
        message: 'Another passenger cancelled.',
      });

      await notifyUserPush({
        userId: coUserId,
        message: 'Co-passenger Cancelled',
        description: 'Another passenger cancelled their booking.',
        reference: rideId,
        modelType: modeType.Ride,
        data: {
          type: 'CO_PASSENGER_CANCELLED',
          rideId: String(rideId),
          cancelledPassengerId: String(passenger._id),
        },
      });
    }

    return callback?.({
      success: true,
      message: 'Cancelled successfully.',
      data:    { rideCancelled: false, remainingPassengers: remaining.length, ...cancelInfo },
    });
  },
);
