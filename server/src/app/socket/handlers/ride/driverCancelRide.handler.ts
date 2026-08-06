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
import { modeType } from '../../../modules/notification/notification.interface';
import { sendNotification } from '../../../utils/sentPushNotification';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { refundToWallet } from '../../../utils/splitFare.utils';

// â”\u20ACâ”\u20AC Helper: cancel single passenger booking + refund + notify â”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20AC
const cancelBookingWithRefund = async (
  passengerId: any,
  rideId: string,
  driverId: string,
  reason: string,
  io: any,
) => {
  const booking = await Booking.findOne({ passengerId });
  if (!booking) return { refundAmount: 0, userId: null };

  const paidAmount = booking.amountPaid ?? 0;

  booking.bookingStatus = BOOKING_STATUS.cancelled;
  booking.refundAmount = paidAmount;
  if (paidAmount > 0) {
    booking.paymentStatus = PAYMENT_STATUS.refunded;
  }
  await booking.save();

  const passenger = await Passenger.findById(passengerId)
    .select('userId')
    .lean();

  if (paidAmount > 0 && passenger?.userId) {
    // 1. Find and update the payment record
    const payment = await Payment.findOne({ booking: booking._id, status: PAYMENT_STATUS.paid });
    if (payment) {
      payment.status = PAYMENT_STATUS.refunded as any;
      payment.isPaid = false;
      await payment.save();

      // Deduct driver (provider) earning from driver's wallet
      if (payment.providerEarning && payment.providerEarning > 0) {
        await User.findByIdAndUpdate(driverId, {
          $inc: { wallet: -payment.providerEarning }
        });
        console.log(`ðŸ’° Deducted driver earning: Â\u20AC${payment.providerEarning} from driver: ${driverId}`);
      }
    }

    // 2. Create Refund document
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

    // 3. Refund to passenger's wallet
    await refundToWallet(
      passenger.userId.toString(),
      paidAmount,
      'driver_cancelled',
      io,
    );
  }

  const refundAmount = paidAmount;
  const notifyMessage =
    refundAmount > 0
      ? 'Your ride has been cancelled by the driver. Refund added to your wallet.'
      : 'Your ride has been cancelled by the driver.';

  if (passenger?.userId) {
    io.to(`user:${passenger.userId}`).emit('ride:cancelled-by-driver', {
      rideId,
      passengerId,
      reason: reason || 'Driver cancelled',
      refundAmount,
      message: notifyMessage,
    });

    const riderUser = await User.findById(passenger.userId)
      .select('fcmToken')
      .lean();

    if (riderUser?.fcmToken) {
      sendNotification([riderUser.fcmToken], {
        receiver: passenger.userId,
        message: 'Ride Cancelled by Driver',
        description: notifyMessage,
        reference: rideId,
        modelType: modeType.Ride,
      }).catch((err: any) =>
        console.warn(`FCM failed for passenger ${passengerId}:`, err),
      );
    }
  }

  return { refundAmount, userId: passenger?.userId };
};

// â”\u20ACâ”\u20AC Helper: cancel entire ride (all active passengers) â”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20AC
const cancelEntireRide = async (
  rideId: string,
  driverId: string,
  reason: string,
  io: any,
  redis: any,
) => {
  const activePassengers = await Passenger.find({
    rideId,
    status: {
      $in: [
        PASSENGER_STATUS.confirmed,
        PASSENGER_STATUS.in_progress,
        PASSENGER_STATUS.driver_arrived,
      ],
    },
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

    // â”\u20ACâ”\u20AC PRIVATE RIDE â”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20AC
    if (ride.type === RIDE_TYPE.private) {
      const passenger = passengerId
        ? await Passenger.findOne({
            _id: passengerId,
            rideId,
            status: {
              $in: [
                PASSENGER_STATUS.confirmed,
                PASSENGER_STATUS.in_progress,
                PASSENGER_STATUS.driver_arrived,
              ],
            },
          })
        : await Passenger.findOne({
            rideId,
            status: {
              $in: [
                PASSENGER_STATUS.confirmed,
                PASSENGER_STATUS.in_progress,
                PASSENGER_STATUS.driver_arrived,
              ],
            },
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

    // â”\u20ACâ”\u20AC SPLIT RIDE â”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20AC
    if (ride.type === RIDE_TYPE.split) {

      // âœ… Case 1: passengerId à¦¨à§‡à¦‡ â\u20AC” à¦ªà§à¦°à§‹ ride cancel à¦•à¦°à§‹
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

      // âœ… Case 2: passengerId à¦†à¦›à§‡ â\u20AC” à¦¶à§à¦§à§ à¦¸à§‡à¦‡ passenger cancel à¦•à¦°à§‹
      const passenger = await Passenger.findOne({
        _id: passengerId,
        rideId,
        status: {
          $in: [
            PASSENGER_STATUS.confirmed,
            PASSENGER_STATUS.in_progress,
            PASSENGER_STATUS.driver_arrived,
          ],
        },
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

      // Notify remaining co-passengers (all active passengers except current)
      const remainingPassengers = await Passenger.find({
        rideId,
        _id: { $ne: passenger._id },
        status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
      }).select('userId');

      const updatedRide = await Ride.findById(rideId)
        .select('bookedSeats totalSeats')
        .lean();
      const remainingSeats =
        (updatedRide?.totalSeats ?? 0) - (updatedRide?.bookedSeats ?? 0);

      for (const p of remainingPassengers) {
        io.to(`user:${p.userId}`).emit('ride:co-passenger-cancelled', {
          rideId,
          cancelledPassengerId: passenger._id,
          remainingSeats,
          message: 'A passenger has been removed by the driver.',
        });

        const coUser = await User.findById(p.userId).select('fcmToken').lean();
        if (coUser?.fcmToken) {
          sendNotification([coUser.fcmToken], {
            receiver: p.userId,
            message: 'Passenger Removed',
            description: 'A passenger has been removed from your split ride by the driver.',
            reference: rideId,
            modelType: modeType.Ride,
          }).catch(() => {});
        }
      }

      // âœ… No passengers left â†’ cancel entire ride
      let rideCancelled = false;
      if (remainingPassengers.length <= 1) {
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: remainingPassengers.length === 0 ? 'No passengers left' : 'Only one passenger remaining. Ride cancelled.',
          cancelledBy: CANCELLED_BY.driver,
          cancelledAt: new Date(),
        });
        await redisCleanup();
        rideCancelled = true;
      }

      return callback?.({
        success: true,
        message: rideCancelled
          ? 'Only one passenger remaining. Ride cancelled.'
          : 'Passenger cancelled from split ride.',
        data: {
          remainingPassengers: remainingPassengers.length,
          rideCancelled,
          refundAmount,
        },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  },
);

