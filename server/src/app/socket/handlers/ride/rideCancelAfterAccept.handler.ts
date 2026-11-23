// handlers/ride/rideCancelAfterAccept.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, CANCELLED_BY, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { BOOKING_STATUS, PAYMENT_STATUS } from '../../../modules/booking/booking.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { revertDriverEarningIfCredited } from '../../../utils/driverEarning.utils';
import { Refund } from '../../../modules/refund/refund.model';
import { Payment } from '../../../modules/payment/payment.model';
import { PaymentService } from '../../../modules/payment/payment.service';
import { REFUND_STATUS, REFUND_TYPE } from '../../../modules/refund/refund.constant';
import { modeType } from '../../../modules/notification/notification.interface';
import { notifyUserPush } from '../../../utils/notifyUser.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { getDepartureDateTime } from '../../../utils/rideSchedule.utils';
import {
  calculateCancellationRefund,
  recalculateSplitFares,
  refundToWallet,
  transferRideOwnership,
} from '../../../utils/splitFare.utils';

// Helper: notify driver (socket + FCM + in-app)
const notifyDriver = async (
  io:        any,
  driverId:  string,
  rideId:    string,
  message:   string,
  extra?:    Record<string, any>,
) => {
  io.to(`driver:${driverId}`).emit('ride:cancelled-by-rider', {
    rideId,
    message,
    ...extra,
  });

  await notifyUserPush({
    userId: driverId,
    message: 'Ride Cancelled by Rider',
    description: message,
    reference: rideId,
    modelType: modeType.Ride,
    data: {
      type: 'RIDE_CANCELLED_BY_RIDER',
      rideId: String(rideId),
    },
  });
};

// When a split ride is cancelled because too few riders remain, the riders still on it did not
// choose to cancel: cancel them, release or fully refund their payment, and tell them.
const cancelRemainingPassengers = async (
  io: any,
  redis: any,
  ride: { driverId?: any },
  rideId: string,
  excludePassengerId: any,
) => {
  const remaining = await Passenger.find({
    rideId,
    _id: { $ne: excludePassengerId },
    status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
  });

  const message = 'Ride was cancelled because not enough passengers remained.';

  for (const p of remaining) {
    const riderId = p.userId?.toString();
    let refunded = 0;

    const booking = await Booking.findOne({ passengerId: p._id });
    if (booking) {
      const payment = await Payment.findOne({ booking: booking._id });
      const hasAuthorizedHold =
        !!payment &&
        [PAYMENT_STATUS.authorized, PAYMENT_STATUS.requires_reauthorization].includes(payment.status as any);

      if (hasAuthorizedHold) {
        await PaymentService.cancelAuthorizedBookingPayment(booking._id.toString());
      }

      const alreadyRefunded = booking.paymentStatus === PAYMENT_STATUS.refunded;
      const paid = hasAuthorizedHold || alreadyRefunded ? 0 : booking.amountPaid ?? 0;

      // Credit the rider first; the booking is only finalised once the money is back.
      if (paid > 0 && riderId) {
        await refundToWallet(riderId, paid, 'cancel_not_enough_passengers', io);
        refunded = paid;
      }

      booking.bookingStatus = BOOKING_STATUS.cancelled;
      if (refunded > 0) {
        booking.refundAmount = refunded;
        booking.paymentStatus = PAYMENT_STATUS.refunded as any;
      }
      await booking.save();

      if (refunded > 0) {
        if (payment && payment.status === PAYMENT_STATUS.paid) {
          payment.status = PAYMENT_STATUS.refunded as any;
          payment.isPaid = false;
          await payment.save();

          // Only reverses money the driver was actually credited (at completion).
          await revertDriverEarningIfCredited({
            rideId,
            driverId: ride.driverId,
            amount: payment.providerEarning,
          });
        }

        await Refund.create({
          user: p.userId,
          ride: rideId,
          type: REFUND_TYPE.cancel_ride,
          paymentIntentId: booking.transactionId || payment?.transactionId || '',
          amount: refunded,
          reason: 'Ride cancelled: not enough passengers remained',
          note: `Ride ${rideId} cancelled after another rider left`,
          status: REFUND_STATUS.confirmed,
        });
      }
    }

    await Passenger.findByIdAndUpdate(p._id, {
      status:             PASSENGER_STATUS.cancelled,
      cancellationReason: 'Only one passenger remaining. Ride cancelled.',
      cancelledBy:        CANCELLED_BY.system,
      refundAmount:       refunded,
    });

    if (ride.driverId) {
      await redis.hincrby(
        `driver:${ride.driverId}:details`,
        'bookedSeats',
        -(p.requestedSeats || 1),
      );
    }

    if (!riderId) continue;

    io.to(`user:${riderId}`).emit('ride:cancelled', {
      rideId,
      message,
      refundAmount: refunded,
    });

    await notifyUserPush({
      userId: riderId,
      message: 'Ride Cancelled',
      description: message,
      reference: rideId,
      modelType: modeType.Ride,
      data: { type: 'RIDE_CANCELLED', rideId: String(rideId) },
    });
  }
};

export const rideCancelAfterAcceptHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, reason = '' } = data;
    const userId = socket.auth?._id?.toString();

    if (!rideId || !userId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const io    = getIO();
    const redis = getRedisClient();

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });

    if (![RIDE_STATUS.accepted, RIDE_STATUS.started].includes(ride.status as any))
      return callback?.({ success: false, message: 'Cannot cancel at this stage' });

    // ── Find passenger ──
    let passenger: any;

    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required for split ride cancellation' });

      passenger = await Passenger.findOne({
        _id:    passengerId,
        rideId,
        userId,
        status: {
          $in: [
            PASSENGER_STATUS.pending,
            PASSENGER_STATUS.confirmed,
            PASSENGER_STATUS.driver_arrived,
            PASSENGER_STATUS.in_progress,
            PASSENGER_STATUS.picked_up,
          ],
        },
      });
    } else {
      passenger = await Passenger.findOne({
        rideId,
        userId,
        status: {
          $in: [
            PASSENGER_STATUS.pending,
            PASSENGER_STATUS.confirmed,
            PASSENGER_STATUS.driver_arrived,
            PASSENGER_STATUS.in_progress,
            PASSENGER_STATUS.picked_up,
          ],
        },
      });
    }

    if (!passenger)
      return callback?.({ success: false, message: 'No active booking found' });

    const booking = await Booking.findOne({ passengerId: passenger._id });
    let paidAmount = booking?.amountPaid ?? 0;

    if (booking) {
      const payment = await Payment.findOne({ booking: booking._id });
      if (
        payment &&
        [PAYMENT_STATUS.authorized, PAYMENT_STATUS.requires_reauthorization].includes(payment.status as any)
      ) {
        await PaymentService.cancelAuthorizedBookingPayment(booking._id.toString());
        paidAmount = 0;
      }
      // No fallback to the estimated fare: only money that was actually captured is refundable.
    }

    // ── Cancellation refund ──
    const departureDateTime = getDepartureDateTime(ride.departureDate, ride.departureTime);
    const { refundAmount, platformAmount, refundReason } = await calculateCancellationRefund(
      paidAmount,
      departureDateTime,
      ride.type as any,
    );

    // B-04: the app showed a hard-coded "20% fee" while the backend applied its own
    // policy. Return the fee actually applied, so the app can display it.
    const feeInfo = {
      paidAmount,
      feeAmount: platformAmount,
      feePercent: paidAmount > 0 ? Math.round((platformAmount / paidAmount) * 10000) / 100 : 0,
      refundDestination: refundAmount > 0 ? 'wallet' : null,
    };

    // Credit the rider first. If this fails the passenger stays active, so the rider can retry.
    if (refundAmount > 0 && booking) {
      await refundToWallet(userId, refundAmount, `cancel_${refundReason}`, io);
    }

    // ── Update passenger & booking ──
    await Passenger.findByIdAndUpdate(passenger._id, {
      status:             PASSENGER_STATUS.cancelled,
      cancellationReason: reason || 'Rider cancelled',
      cancelledBy:        CANCELLED_BY.user,
      refundAmount,
    });

    const bookingDoc = await Booking.findOne({ passengerId: passenger._id });
    if (bookingDoc) {
      bookingDoc.bookingStatus = BOOKING_STATUS.cancelled;
      bookingDoc.refundAmount = refundAmount;
      if (refundAmount > 0) {
        bookingDoc.paymentStatus = PAYMENT_STATUS.refunded as any;
      }
      await bookingDoc.save();
    }

    if (refundAmount > 0 && bookingDoc) {
      // 1. Find and update the payment record
      const payment = await Payment.findOne({ booking: bookingDoc._id, status: PAYMENT_STATUS.paid });
      if (payment) {
        payment.status = PAYMENT_STATUS.refunded as any;
        payment.isPaid = false;
        await payment.save();

        // 2. Revert the driver's wallet credit, only if one was actually made (at completion)
        await revertDriverEarningIfCredited({
          rideId,
          driverId: ride.driverId,
          amount: payment.providerEarning,
        });
      }

      // 3. Create Refund record
      await Refund.create({
        user: userId,
        ride: rideId,
        type: REFUND_TYPE.cancel_ride,
        paymentIntentId: bookingDoc.transactionId || payment?.transactionId || '',
        amount: refundAmount,
        reason: `Rider cancelled: ${reason || refundReason}`,
        note: `Ride ${rideId} cancelled by rider. Reason: ${refundReason}`,
        status: REFUND_STATUS.confirmed,
      });
    }

    if (platformAmount > 0) {
      console.log(`💼 Platform revenue €${platformAmount} | ride ${rideId}`);
    }

    // ── Decrement seats ──
    await Ride.findByIdAndUpdate(rideId, {
      $inc: {
        bookedSeats:      -(passenger.requestedSeats  || 1),
        malePassengers:   -(passenger.malePassengers  || 0),
        femalePassengers: -(passenger.femalePassengers || 0),
      },
    });
    if (ride.driverId) {
      await redis.hincrby(
        `driver:${ride.driverId}:details`,
        'bookedSeats',
        -(passenger.requestedSeats || 1),
      );
    }

    // The cancelling rider used to get only the ack, which is sent last (after
    // fare recalculation and every driver/co-rider push). Confirm the cancel
    // right away with the same numbers as the ack.
    io.to(`user:${userId}`).emit('ride:cancelled', {
      rideId,
      passengerId: passenger._id.toString(),
      cancelledBy: CANCELLED_BY.user,
      refundAmount,
      refundReason,
      ...feeInfo,
      message: refundAmount > 0
        ? `Your ride has been cancelled. €${refundAmount.toFixed(2)} has been refunded to your wallet.`
        : 'Your ride has been cancelled.',
    });

    // ── PRIVATE RIDE ──
    if (ride.type === RIDE_TYPE.private) {
      await Ride.findByIdAndUpdate(rideId, {
        status:             RIDE_STATUS.cancelled,
        cancellationReason: reason || 'Rider cancelled',
        cancelledBy:        CANCELLED_BY.user,
        cancelledAt:        new Date(),
      });

      await Promise.all([
        redis.del(`ride:active:${rideId}`),
        redis.zrem('ride:matching:queue', rideId),
        redis.del(`ride:request:${rideId}`),
      ]);

      // ✅ Notify driver ──- only ride:cancelled-by-rider
      if (ride.driverId) {
        await notifyDriver(
          io,
          ride.driverId.toString(),
          rideId,
          reason || 'Rider cancelled the ride.',
          { refundAmount },
        );
      }

      return callback?.({
        success: true,
        message: 'Ride cancelled.',
        data:    { refundAmount, refundReason, ...feeInfo, rideCancelled: true },
      });
    }

    // ── SPLIT RIDE ──

    // Case 3: rideCreatedBy cancelled → check if only 1 passenger remains
    if (ride.rideCreatedBy?.toString() === userId) {
      const remainingAfterCreator = await Passenger.countDocuments({
        rideId,
        _id: { $ne: passenger._id },
        status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
      });

      if (remainingAfterCreator <= 1) {
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: remainingAfterCreator === 0 ? 'Creator cancelled, no passengers remaining' : 'Creator cancelled, only one passenger remaining. Ride cancelled.',
          cancelledBy: CANCELLED_BY.user,
          cancelledAt: new Date(),
        });
        await Promise.all([
          redis.del(`ride:active:${rideId}`),
          redis.zrem('ride:matching:queue', rideId),
        ]);
        await cancelRemainingPassengers(io, redis, ride, rideId, passenger._id);

        // ✅ Notify driver ──- only ride:cancelled-by-rider
        if (ride.driverId) {
          await notifyDriver(
            io,
            ride.driverId.toString(),
            rideId,
            remainingAfterCreator === 0 ? 'Ride creator cancelled. No passengers remaining.' : 'Ride creator cancelled. Only one passenger remaining. Ride cancelled.',
          );
        }

        return callback?.({
          success: true,
          message: 'Ride cancelled - only one passenger remaining.',
          data:    { refundAmount, refundReason, ...feeInfo, rideCancelled: true },
        });
      }

      const transferred = await transferRideOwnership(rideId, userId, io);
      if (!transferred) {
        await Ride.findByIdAndUpdate(rideId, {
          status:             RIDE_STATUS.cancelled,
          cancellationReason: 'Creator cancelled, no passengers remaining',
          cancelledBy:        CANCELLED_BY.user,
          cancelledAt:        new Date(),
        });
        await Promise.all([
          redis.del(`ride:active:${rideId}`),
          redis.zrem('ride:matching:queue', rideId),
        ]);

        // ✅ Notify driver ──- only ride:cancelled-by-rider
        if (ride.driverId) {
          await notifyDriver(
            io,
            ride.driverId.toString(),
            rideId,
            'Ride creator cancelled. No passengers remaining.',
          );
        }

        return callback?.({
          success: true,
          message: 'Ride cancelled - no other passengers.',
          data:    { refundAmount, refundReason, ...feeInfo, rideCancelled: true },
        });
      }
    }

    // Check remaining passengers
    const remainingCount = await Passenger.countDocuments({
      rideId,
      status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
    });

    if (remainingCount <= 1) {
      await Ride.findByIdAndUpdate(rideId, {
        status:             RIDE_STATUS.cancelled,
        cancellationReason: remainingCount === 0 ? 'Last passenger cancelled' : 'Only one passenger remaining. Ride cancelled.',
        cancelledBy:        CANCELLED_BY.user,
        cancelledAt:        new Date(),
      });
      await Promise.all([
        redis.del(`ride:active:${rideId}`),
        redis.zrem('ride:matching:queue', rideId),
      ]);
      await cancelRemainingPassengers(io, redis, ride, rideId, passenger._id);

      // ✅ Notify driver ──- only ride:cancelled-by-rider
      if (ride.driverId) {
        await notifyDriver(
          io,
          ride.driverId.toString(),
          rideId,
          remainingCount === 0 ? 'All passengers cancelled. Ride is now cancelled.' : 'Only one passenger remaining. Ride cancelled.',
        );
      }

      return callback?.({
        success: true,
        message: 'Ride cancelled - only one passenger remaining.',
        data:    { refundAmount, refundReason, ...feeInfo, rideCancelled: true },
      });
    }

    // Remaining passengers exist ──- recalculate + notify driver only
    await recalculateSplitFares(rideId, 'passenger_cancelled', io);

    // ✅ Notify driver ──- only ride:cancelled-by-rider (not passenger-cancelled)
    if (ride.driverId) {
      await notifyDriver(
        io,
        ride.driverId.toString(),
        rideId,
        `A passenger cancelled. ${remainingCount} passenger(s) remaining.`,
        {
          passengerId:         passenger._id,
          remainingPassengers: remainingCount,
        },
      );
    }

    // Notify co-passengers — ride:co-passenger-cancelled
    const others = await Passenger.find({
      rideId,
      _id:    { $ne: passenger._id },
      status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
    }).select('userId');

    for (const p of others) {
      const coUserId = p.userId.toString();
      io.to(`user:${coUserId}`).emit('ride:co-passenger-cancelled', {
        rideId,
        cancelledPassengerId: passenger._id,
        message:              'Another passenger cancelled their booking.',
      });

      await notifyUserPush({
        userId: coUserId,
        message: 'Co-passenger Cancelled',
        description: 'Another passenger has cancelled. Your fare may be updated.',
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
      message: 'Booking cancelled.',
      data: {
        passengerId:         passenger._id,
        refundAmount,
        refundReason,
        ...feeInfo,
        rideCancelled:       false,
        remainingPassengers: remainingCount,
      },
    });
  },
);

