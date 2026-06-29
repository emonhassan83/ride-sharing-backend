// handlers/ride/rideCancelAfterAccept.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, CANCELLED_BY, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { User } from '../../../modules/user/user.model';
import { modeType } from '../../../modules/notification/notification.interface';
import { sendNotification } from '../../../utils/sentPushNotification';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import {
  calculateCancellationRefund,
  recalculateSplitFares,
  refundToWallet,
  transferRideOwnership,
} from '../../../utils/splitFare.utils';

// ── Helper: notify driver (socket + FCM) ─────────────────────────────────────
const notifyDriver = async (
  io:        any,
  driverId:  string,
  rideId:    string,
  message:   string,
  extra?:    Record<string, any>,
) => {
  // Socket
  io.to(`driver:${driverId}`).emit('ride:cancelled-by-rider', {
    rideId,
    message,
    ...extra,
  });

  // FCM push
  const driver = await User.findById(driverId).select('fcmToken').lean();
  if (driver?.fcmToken) {
    sendNotification([driver.fcmToken], {
      receiver:    driverId,
      message:     'Ride Cancelled by Rider',
      description: message,
      reference:   rideId,
      modelType:   modeType.Ride,
    }).catch(() => {});
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

    // ── Find passenger ────────────────────────────────────────────────────────
    let passenger: any;

    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required for split ride cancellation' });

      passenger = await Passenger.findOne({
        _id:    passengerId,
        rideId,
        userId,
        status: { $in: [PASSENGER_STATUS.confirmed, PASSENGER_STATUS.driver_arrived, PASSENGER_STATUS.pending] },
      });
    } else {
      passenger = await Passenger.findOne({
        rideId,
        userId,
        status: { $in: [PASSENGER_STATUS.confirmed, PASSENGER_STATUS.driver_arrived, PASSENGER_STATUS.pending] },
      });
    }

    if (!passenger)
      return callback?.({ success: false, message: 'No active booking found' });

    const booking    = await Booking.findOne({ passengerId: passenger._id }).lean();
    const paidAmount = booking?.amountPaid ?? passenger.estimatedFare ?? 0;

    // ── Cancellation refund ───────────────────────────────────────────────────
    const departureDateTime = new Date(`${ride.departureDate}T${ride.departureTime}:00`);
    const { refundAmount, platformAmount, refundReason } = await calculateCancellationRefund(
      paidAmount,
      (passenger as any).createdAt || new Date(),
      departureDateTime,
    );

    // ── Update passenger & booking ────────────────────────────────────────────
    await Passenger.findByIdAndUpdate(passenger._id, {
      status:             PASSENGER_STATUS.cancelled,
      cancellationReason: reason || 'Rider cancelled',
      cancelledBy:        CANCELLED_BY.user,
      refundAmount,
    });

    await Booking.findOneAndUpdate(
      { passengerId: passenger._id },
      { bookingStatus: BOOKING_STATUS.cancelled, refundAmount },
    );

    // ── Refund to wallet ──────────────────────────────────────────────────────
    if (refundAmount > 0) {
      await refundToWallet(userId, refundAmount, `cancel_${refundReason}`, io);
    }

    if (platformAmount > 0) {
      console.log(`💼 Platform revenue £${platformAmount} | ride ${rideId}`);
    }

    // ── Decrement seats ───────────────────────────────────────────────────────
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

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
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

      // ✅ Notify driver — only ride:cancelled-by-rider
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
        data:    { refundAmount, refundReason, rideCancelled: true },
      });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────

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

        // ✅ Notify driver — only ride:cancelled-by-rider
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
          message: 'Ride cancelled — only one passenger remaining.',
          data:    { refundAmount, refundReason, rideCancelled: true },
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

        // ✅ Notify driver — only ride:cancelled-by-rider
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
          message: 'Ride cancelled — no other passengers.',
          data:    { refundAmount, refundReason, rideCancelled: true },
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

      // ✅ Notify driver — only ride:cancelled-by-rider
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
        message: 'Ride cancelled — only one passenger remaining.',
        data:    { refundAmount, refundReason, rideCancelled: true },
      });
    }

    // Remaining passengers exist — recalculate + notify driver only
    await recalculateSplitFares(rideId, 'passenger_cancelled', io);

    // ✅ Notify driver — only ride:cancelled-by-rider (not passenger-cancelled)
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

    // ✅ Notify co-passengers — ride:co-passenger-cancelled (riders listen to this)
    const others = await Passenger.find({
      rideId,
      _id:    { $ne: passenger._id },
      status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
    }).select('userId fcmToken');

    for (const p of others) {
      io.to(`user:${p.userId}`).emit('ride:co-passenger-cancelled', {
        rideId,
        cancelledPassengerId: passenger._id,
        message:              'Another passenger cancelled their booking.',
      });

      // FCM to co-passengers
      const coUser = await User.findById(p.userId).select('fcmToken').lean();
      if (coUser?.fcmToken) {
        sendNotification([coUser.fcmToken], {
          receiver:    p.userId,
          message:     'Co-passenger Cancelled',
          description: 'Another passenger has cancelled. Your fare may be updated.',
          reference:   rideId,
          modelType:   modeType.Ride,
        }).catch(() => {});
      }
    }

    return callback?.({
      success: true,
      message: 'Booking cancelled.',
      data: {
        passengerId:         passenger._id,
        refundAmount,
        refundReason,
        rideCancelled:       false,
        remainingPassengers: remainingCount,
      },
    });
  },
);