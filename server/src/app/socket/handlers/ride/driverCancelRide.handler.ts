// handlers/driver/driverCancelRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import {
  CANCELLED_BY,
  RIDE_STATUS,
  RIDE_TYPE,
} from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS, PAYMENT_STATUS } from '../../../modules/booking/booking.constant';
import {
  REFUND_STATUS,
  REFUND_TYPE,
} from '../../../modules/refund/refund.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { Refund } from '../../../modules/refund/refund.model';
import { User } from '../../../modules/user/user.model';
import { Payment } from '../../../modules/payment/payment.model';
import { PaymentService } from '../../../modules/payment/payment.service';
import { modeType } from '../../../modules/notification/notification.interface';
import { notifyUserPush } from '../../../utils/notifyUser.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { refundToWallet } from '../../../utils/splitFare.utils';

const ACTIVE_PASSENGER_STATUSES = [
  PASSENGER_STATUS.confirmed,
  PASSENGER_STATUS.driver_arrived,
  PASSENGER_STATUS.in_progress,
  PASSENGER_STATUS.picked_up,
];

// Helper: cancel single passenger booking + refund + notify
const cancelBookingWithRefund = async (
  passengerId: any,
  rideId: string,
  driverId: string,
  reason: string,
  io: any,
) => {
  const booking = await Booking.findOne({ passengerId });
  const passenger = await Passenger.findById(passengerId)
    .select('userId')
    .lean();

  let paidAmount = 0;
  let payment: any = null;

  if (booking) {
    const paymentForAuthorization = await Payment.findOne({ booking: booking._id });
    const hasAuthorizedHold =
      paymentForAuthorization &&
      [PAYMENT_STATUS.authorized, PAYMENT_STATUS.requires_reauthorization].includes(
        paymentForAuthorization.status as any
      );

    if (hasAuthorizedHold) {
      await PaymentService.cancelAuthorizedBookingPayment(booking._id.toString());
    }

    paidAmount = hasAuthorizedHold ? 0 : booking.amountPaid ?? 0;

    booking.bookingStatus = BOOKING_STATUS.cancelled;
    booking.refundAmount = paidAmount;
    if (paidAmount > 0) {
      booking.paymentStatus = PAYMENT_STATUS.refunded;
    } else if (hasAuthorizedHold) {
      booking.paymentStatus = PAYMENT_STATUS.cancelled_authorization as any;
    }
    await booking.save();

    if (paidAmount > 0 && passenger?.userId) {
      payment = await Payment.findOne({ booking: booking._id, status: PAYMENT_STATUS.paid });
      if (payment) {
        payment.status = PAYMENT_STATUS.refunded as any;
        payment.isPaid = false;
        await payment.save();

        if (payment.providerEarning && payment.providerEarning > 0) {
          await User.findByIdAndUpdate(driverId, {
            $inc: { wallet: -payment.providerEarning }
          });
        }
      }

      await Refund.create({
        user: passenger.userId,
        ride: rideId,
        type: REFUND_TYPE.cancel_ride,
        paymentIntentId: booking.transactionId || payment?.transactionId || '',
        amount: paidAmount,
        reason: `Driver cancelled: ${reason}`,
        note: `Ride ${rideId} cancelled by driver`,
        status: REFUND_STATUS.confirmed,
      });

      await refundToWallet(
        passenger.userId.toString(),
        paidAmount,
        'driver_cancelled',
        io,
      );
    }
  }

  const refundAmount = paidAmount;
  const notifyMessage =
    refundAmount > 0
      ? 'Your ride has been cancelled by the driver. Refund added to your wallet.'
      : 'Your ride has been cancelled by the driver.';

  if (passenger?.userId) {
    const userId = passenger.userId.toString();

    io.to(`user:${userId}`).emit('ride:cancelled-by-driver', {
      rideId,
      passengerId: passengerId?.toString?.() || passengerId,
      reason: reason || 'Driver cancelled',
      refundAmount,
      message: notifyMessage,
    });

    await notifyUserPush({
      userId,
      message: 'Ride Cancelled by Driver',
      description: notifyMessage,
      reference: rideId,
      modelType: modeType.Ride,
      data: {
        type: 'RIDE_CANCELLED_BY_DRIVER',
        rideId: String(rideId),
        passengerId: String(passengerId),
        refundAmount,
      },
    });
  }

  return { refundAmount, userId: passenger?.userId };
};

// �\u20AC�\u20AC Helper: cancel entire ride (all active passengers) �\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC
const cancelEntireRide = async (
  rideId: string,
  driverId: string,
  reason: string,
  io: any,
  redis: any,
) => {
  const activePassengers = await Passenger.find({
    rideId,
    status: { $in: ACTIVE_PASSENGER_STATUSES },
  }).select('_id userId requestedSeats');

  let totalRefunded = 0

  // Cancel all passengers + refund
  for (const passenger of activePassengers) {
    const { refundAmount } = await cancelBookingWithRefund(
      passenger._id,
      rideId,
      driverId,
      reason,
      io,
    );

    totalRefunded += refundAmount

    await Passenger.findByIdAndUpdate(passenger._id, {
      status: PASSENGER_STATUS.cancelled,
      cancellationReason: reason || 'Driver cancelled entire ride',
      cancelledBy: CANCELLED_BY.driver,
    });
  }

  // Cancel the ride itself
  await Ride.findByIdAndUpdate(rideId, {
    status: RIDE_STATUS.cancelled,
    cancellationReason: reason || 'Driver cancelled entire ride',
    cancelledBy: CANCELLED_BY.driver,
    cancelledAt: new Date(),
  });

  // Redis cleanup
  await Promise.all([
    redis.del(`ride:active:${rideId}`),
    redis.del(`ride:request:${rideId}`),
    redis.del(`driver:${driverId}:activeRide`),
    redis.zrem('ride:matching:queue', rideId),
    redis.hset(`driver:${driverId}:details`, 'bookedSeats', 0),
  ]);

  return {
    cancelledPassengerCount: activePassengers.length,
    totalRefunded,
  };
};

export const driverCancelRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, reason = '' } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const ride = await Ride.findById(rideId);
    if (!ride) return callback?.({ success: false, message: 'Ride not found' });
    if (ride.driverId?.toString() !== driverId)
      return callback?.({ success: false, message: 'Not assigned to this ride' });

    const cancellableStatuses = [RIDE_STATUS.accepted, RIDE_STATUS.started];
    if (!cancellableStatuses.includes(ride.status as any))
      return callback?.({ success: false, message: 'Cannot cancel now' });

    const redis = getRedisClient();
    const io = getIO();

    const redisCleanup = async () => {
      await Promise.all([
        redis.del(`ride:active:${rideId}`),
        redis.del(`ride:request:${rideId}`),
        redis.del(`driver:${driverId}:activeRide`),
        redis.zrem('ride:matching:queue', rideId),
      ]);
    };

    // �\u20AC�\u20AC PRIVATE RIDE �\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC
    if (ride.type === RIDE_TYPE.private) {
      const passenger = passengerId
        ? await Passenger.findOne({
            _id: passengerId,
            rideId,
            status: { $in: ACTIVE_PASSENGER_STATUSES },
          })
        : await Passenger.findOne({
            rideId,
            status: { $in: ACTIVE_PASSENGER_STATUSES },
          });

      if (!passenger)
        return callback?.({ success: false, message: 'No active passenger found' });

      const { refundAmount } = await cancelBookingWithRefund(
        passenger._id,
        rideId,
        driverId,
        reason,
        io,
      );

      await Passenger.findByIdAndUpdate(passenger._id, {
        status: PASSENGER_STATUS.cancelled,
        cancellationReason: reason || 'Driver cancelled',
        cancelledBy: CANCELLED_BY.driver,
      });

      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.cancelled,
        cancellationReason: reason || 'Driver cancelled',
        cancelledBy: CANCELLED_BY.driver,
        cancelledAt: new Date(),
      });

      await redis.hincrby(
        `driver:${driverId}:details`,
        'bookedSeats',
        -(passenger.requestedSeats || 1),
      );
      await redisCleanup();

      return callback?.({
        success: true,
        message: 'Private ride cancelled',
        data: { passengerCount: 1, rideCancelled: true, refundAmount },
      });
    }

    // �\u20AC�\u20AC SPLIT RIDE �\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC�\u20AC
    if (ride.type === RIDE_TYPE.split) {

      // ✅ Case 1: passengerId নেই �\u20AC� পুরো ride cancel করো
      if (!passengerId) {
        const { cancelledPassengerCount, totalRefunded } = await cancelEntireRide(
          rideId,
          driverId,
          reason,
          io,
          redis,
        );

        // Notify driver
        io.to(`driver:${driverId}`).emit('ride:cancelled-by-driver', {
          rideId,
          reason: reason || 'Driver cancelled entire ride',
          message: `Entire ride cancelled. ${cancelledPassengerCount} passenger(s) notified and refunded.`,
        });

        return callback?.({
          success: true,
          message: `Entire split ride cancelled. ${cancelledPassengerCount} passenger(s) affected.`,
          data: {
            rideCancelled: true,
            cancelledPassengerCount,
            totalRefunded,
          },
        });
      }

      // Case 2: passengerId আছে — শুধু সেই passenger cancel করো
      const passenger = await Passenger.findOne({
        _id: passengerId,
        rideId,
        status: { $in: ACTIVE_PASSENGER_STATUSES },
      });

      if (!passenger)
        return callback?.({ success: false, message: 'Passenger not found or not active' });

      const { refundAmount } = await cancelBookingWithRefund(
        passenger._id,
        rideId,
        driverId,
        reason,
        io,
      );

      await Passenger.findByIdAndUpdate(passenger._id, {
        status: PASSENGER_STATUS.cancelled,
        cancellationReason: reason || 'Driver cancelled passenger',
        cancelledBy: CANCELLED_BY.driver,
      });

      await Ride.findByIdAndUpdate(rideId, {
        $inc: {
          bookedSeats:      -(passenger.requestedSeats  || 1),
          malePassengers:   -(passenger.malePassengers  || 0),
          femalePassengers: -(passenger.femalePassengers || 0),
        },
      });

      await redis.hincrby(
        `driver:${driverId}:details`,
        'bookedSeats',
        -(passenger.requestedSeats || 1),
      );

      // Remaining active passengers except the one just cancelled
      const remainingPassengers = await Passenger.find({
        rideId,
        _id: { $ne: passenger._id },
        status: { $in: ACTIVE_PASSENGER_STATUSES },
      }).select('_id userId requestedSeats malePassengers femalePassengers');

      const updatedRide = await Ride.findById(rideId)
        .select('bookedSeats totalSeats')
        .lean();
      const remainingSeats =
        (updatedRide?.totalSeats ?? 0) - (updatedRide?.bookedSeats ?? 0);

      // ≤1 left → cancel whole ride + refund/notify remaining passenger(s)
      let rideCancelled = false;
      if (remainingPassengers.length <= 1) {
        for (const p of remainingPassengers) {
          await cancelBookingWithRefund(
            p._id,
            rideId,
            driverId,
            reason || 'Only one passenger remaining. Ride cancelled.',
            io,
          );
          await Passenger.findByIdAndUpdate(p._id, {
            status: PASSENGER_STATUS.cancelled,
            cancellationReason:
              remainingPassengers.length === 0
                ? 'No passengers left'
                : 'Only one passenger remaining. Ride cancelled.',
            cancelledBy: CANCELLED_BY.driver,
          });
        }

        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason:
            remainingPassengers.length === 0
              ? 'No passengers left'
              : 'Only one passenger remaining. Ride cancelled.',
          cancelledBy: CANCELLED_BY.driver,
          cancelledAt: new Date(),
        });
        await redisCleanup();
        rideCancelled = true;
      } else {
        // Notify co-passengers that one rider was removed
        for (const p of remainingPassengers) {
          const userId = p.userId.toString();
          io.to(`user:${userId}`).emit('ride:co-passenger-cancelled', {
            rideId,
            cancelledPassengerId: passenger._id,
            remainingSeats,
            message: 'A passenger has been removed by the driver.',
          });

          await notifyUserPush({
            userId,
            message: 'Passenger Removed',
            description:
              'A passenger has been removed from your split ride by the driver.',
            reference: rideId,
            modelType: modeType.Ride,
            data: {
              type: 'CO_PASSENGER_REMOVED_BY_DRIVER',
              rideId: String(rideId),
              cancelledPassengerId: String(passenger._id),
            },
          });
        }
      }

      return callback?.({
        success: true,
        message: rideCancelled
          ? 'Only one passenger remaining. Ride cancelled.'
          : 'Passenger cancelled from split ride.',
        data: {
          remainingPassengers: rideCancelled ? 0 : remainingPassengers.length,
          rideCancelled,
          refundAmount,
        },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  },
);

