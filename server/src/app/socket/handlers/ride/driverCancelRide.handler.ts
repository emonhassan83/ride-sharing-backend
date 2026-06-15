// handlers/driver/driverCancelRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { CANCELLED_BY, RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { REFUND_STATUS, REFUND_TYPE } from '../../../modules/refund/refund.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { Refund } from '../../../modules/refund/refund.model';
import { User } from '../../../modules/user/user.model';
import { modeType } from '../../../modules/notification/notification.interface';
import { sendNotification } from '../../../utils/sentPushNotification';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { refundToWallet } from '../../../utils/splitFare.utils';

// ── Helper: cancel booking + refund record + wallet + push notify ─────────────
const cancelBookingWithRefund = async (
  passengerId: any,
  rideId:      string,
  driverId:    string,
  reason:      string,
  io:          any,
) => {
  const booking = await Booking.findOne({ passengerId });
  if (!booking) return { refundAmount: 0, passengerId: null };

  const paidAmount = booking.amountPaid ?? 0;

  booking.bookingStatus = BOOKING_STATUS.cancelled;
  booking.refundAmount  = paidAmount;
  await booking.save();

  const passenger = await Passenger.findById(passengerId).select('userId').lean();

  if (paidAmount > 0 && passenger?.userId) {
    await Refund.create({
      user:            passenger.userId,
      ride:            rideId,
      type:            REFUND_TYPE.cancel_ride,
      paymentIntentId: booking.transactionId,
      amount:          paidAmount,
      reason:          `Driver cancelled: ${reason}`,
      note:            `Ride ${rideId} cancelled by driver`,
      status:          REFUND_STATUS.confirmed,
    });

    await refundToWallet(
      passenger.userId.toString(),
      paidAmount,
      'driver_cancelled',
      io,
    );
  }

  // ✅ Socket notify
  const refundAmount = paidAmount;
  const notifyMessage = refundAmount > 0
    ? 'Your ride has been cancelled by the driver. Refund added to your wallet.'
    : 'Your ride has been cancelled by the driver.';

  if (passenger?.userId) {
    io.to(`user:${passenger.userId}`).emit('ride:cancelled-by-driver', {
      rideId,
      passengerId,
      reason:       reason || 'Driver cancelled',
      refundAmount,
      message:      notifyMessage,
    });

    // ✅ FCM push notification
    const riderUser = await User.findById(passenger.userId)
      .select('fcmToken')
      .lean();

    if (riderUser?.fcmToken) {
      sendNotification([riderUser.fcmToken], {
        receiver:    passenger.userId,
        message:     'Ride Cancelled by Driver',
        description: notifyMessage,
        reference:   rideId,
        modelType:   modeType.Ride,
      }).catch((err: any) => console.warn(`FCM failed for passenger ${passengerId}:`, err));
    }
  }

  return { refundAmount, passengerId: passenger?.userId };
};

export const driverCancelRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, reason = '' } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });
    if (ride.driverId?.toString() !== driverId)
      return callback?.({ success: false, message: 'Not assigned to this ride' });

    const cancellableStatuses = [RIDE_STATUS.accepted, RIDE_STATUS.started];
    if (!cancellableStatuses.includes(ride.status as any))
      return callback?.({ success: false, message: 'Cannot cancel now' });

    const redis = getRedisClient();
    const io    = getIO();

    const redisCleanup = async () => {
      await Promise.all([
        redis.del(`ride:active:${rideId}`),
        redis.del(`ride:request:${rideId}`),
        redis.del(`driver:${driverId}:activeRide`),
        redis.zrem('ride:matching:queue', rideId),
      ]);
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
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

      // ✅ Socket + FCM inside helper
      const { refundAmount } = await cancelBookingWithRefund(
        passenger._id, rideId, driverId, reason, io,
      );

      passenger.status             = PASSENGER_STATUS.cancelled;
      passenger.cancellationReason = reason || 'Driver cancelled';
      passenger.cancelledBy        = CANCELLED_BY.driver;
      await passenger.save();

      await Ride.findByIdAndUpdate(rideId, {
        status:             RIDE_STATUS.cancelled,
        cancellationReason: reason || 'Driver cancelled',
        cancelledBy:        CANCELLED_BY.driver,
        cancelledAt:        new Date(),
      });

      await redis.hincrby(`driver:${driverId}:details`, 'bookedSeats', -(passenger.requestedSeats || 1));
      await redisCleanup();

      return callback?.({
        success: true,
        message: 'Private ride cancelled',
        data:    { passengerCount: 1, rideCancelled: true, refundAmount },
      });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required for split ride' });

      const passenger = await Passenger.findOne({
        _id: passengerId, rideId,
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

      // ✅ Socket + FCM inside helper
      const { refundAmount } = await cancelBookingWithRefund(
        passenger._id, rideId, driverId, reason, io,
      );

      passenger.status             = PASSENGER_STATUS.cancelled;
      passenger.cancellationReason = reason || 'Driver cancelled passenger';
      passenger.cancelledBy        = CANCELLED_BY.driver;
      await passenger.save();

      await Ride.findByIdAndUpdate(rideId, {
        $inc: { bookedSeats: -(passenger.requestedSeats || 1) },
      });
      await redis.hincrby(`driver:${driverId}:details`, 'bookedSeats', -(passenger.requestedSeats || 1));

      // Notify co-passengers
      const remainingPassengers = await Passenger.find({
        rideId,
        status: { $in: [PASSENGER_STATUS.confirmed, PASSENGER_STATUS.in_progress, PASSENGER_STATUS.driver_arrived] },
      }).select('userId');

      const updatedRide    = await Ride.findById(rideId).select('bookedSeats totalSeats').lean();
      const remainingSeats = (updatedRide?.totalSeats ?? 0) - (updatedRide?.bookedSeats ?? 0);

      for (const p of remainingPassengers) {
        io.to(`user:${p.userId}`).emit('ride:co-passenger-cancelled', {
          rideId,
          cancelledPassengerId: passenger._id,
          remainingSeats,
          message:              'A passenger has been removed by the driver.',
        });

        // FCM to co-passengers
        const coUser = await User.findById(p.userId).select('fcmToken').lean();
        if (coUser?.fcmToken) {
          sendNotification([coUser.fcmToken], {
            receiver:    p.userId,
            message:     'Passenger Removed',
            description: 'A passenger has been removed from your split ride by the driver.',
            reference:   rideId,
            modelType:   modeType.Ride,
          }).catch(() => {});
        }
      }

      let rideCancelled = false;
      if (remainingPassengers.length === 0) {
        await Ride.findByIdAndUpdate(rideId, {
          status:             RIDE_STATUS.cancelled,
          cancellationReason: 'No passengers left',
          cancelledBy:        CANCELLED_BY.driver,
          cancelledAt:        new Date(),
        });
        await redisCleanup();
        rideCancelled = true;
      }

      return callback?.({
        success: true,
        message: rideCancelled ? 'Last passenger cancelled. Ride cancelled.' : 'Passenger cancelled.',
        data:    { remainingPassengers: remainingPassengers.length, rideCancelled, refundAmount },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  },
);