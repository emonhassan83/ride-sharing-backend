// jobs/noShowPassengers.job.ts
import { getRedisClient } from '../config/redis.config';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { Passenger } from '../modules/passenger/passenger.model';
import { Ride } from '../modules/ride/ride.model';
import { RIDE_STATUS } from '../modules/ride/ride.constant';
import { Setting } from '../modules/settings/settings.model';
import { getIO } from '../socket/socket.init';
import { recalculateSplitFares } from '../utils/splitFare.utils';
import { sendNotification } from '../utils/sentPushNotification'; // ← Import করো
import { modeType } from '../modules/notification/notification.interface';
import { User } from '../modules/user/user.model';

const BATCH_SIZE = 50;

export const checkNoShowPassengers = async (): Promise<void> => {
  try {
    const io = getIO();
    const setting = await Setting.findOne({ key: 'waitingTimeMinutes' }).lean();
    const waitMin = Number(setting?.value ?? 60);
    const cutoff = new Date(Date.now() - waitMin * 60 * 1000);

    const noShows = await Passenger.find({
      status: PASSENGER_STATUS.driver_arrived,
      arriveAt: { $lte: cutoff },
      isNoShow: { $ne: true },
      pickedUpAt: null,
    })
      .limit(BATCH_SIZE)
      .lean();

    if (!noShows.length) return;

    for (const passenger of noShows) {
      // ── Mark as No-Show ─────────────────────────────────────────────
      await Passenger.findByIdAndUpdate(passenger._id, {
        status: PASSENGER_STATUS.cancelled,
        isNoShow: true,
        cancellationReason: 'no_show',
        cancelledBy: 'system',
      });

      // ── Get Ride & Driver Info ──────────────────────────────────────
      const ride = await Ride.findById(passenger.rideId)
        .select('driverId rideCreatedBy type')
        .lean();

      if (!ride) continue;

      // ── 1. Send Notification to Passenger (Rider) ───────────────────
      const rider = await User.findById(passenger.userId)
      if (rider && rider?.fcmToken) {
        await sendNotification([rider.fcmToken || ''], {
          receiver: passenger.userId,
          message: 'You were marked as No-Show',
          description: 'You did not show up at the pickup location. No refund will be issued for this ride.',
          reference: passenger.rideId.toString(),
          modelType: modeType.Ride,
        }).catch(() => {});
      }

      // ── 2. Send Notification to Driver ──────────────────────────────
      const driver = await User.findById(ride.driverId)
      if (driver && driver?.fcmToken) {
        await sendNotification([driver.fcmToken], {
          receiver: ride.driverId,
          message: 'Passenger No-Show',
          description: 'One passenger did not show up. You may proceed with the ride.',
          reference: passenger.rideId.toString(),
          modelType: modeType.Ride,
        }).catch(() => {});
      }

      // ── Real-time Socket Events ─────────────────────────────────────
      io.to(`user:${passenger.userId}`).emit('ride:no-show', {
        rideId: passenger.rideId,
        passengerId: passenger._id,
        message: 'You were marked as no-show. No refund will be issued.',
      });

      if (ride.driverId) {
        io.to(`driver:${ride.driverId}`).emit('ride:passenger-no-show', {
          rideId: passenger.rideId,
          passengerId: passenger._id,
          message: 'Passenger no-show. You may proceed.',
        });
      }

      // ── Update Ride Seats ───────────────────────────────────────────
      await Ride.findByIdAndUpdate(passenger.rideId, {
        $inc: { bookedSeats: -(passenger.requestedSeats || 1) },
      });

      // ── Recalculate fares for Split Ride ────────────────────────────
      if (ride.type === 'split') {
        await recalculateSplitFares(
          passenger.rideId.toString(),
          'passenger_cancelled',
          io
        );
      }

      // ── Cancel ride if no passengers left ───────────────────────────
      const remaining = await Passenger.countDocuments({
        rideId: passenger.rideId,
        status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
      });

      if (remaining === 0) {
        await Ride.findByIdAndUpdate(passenger.rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: 'all_passengers_no_show',
        });

        const redis = getRedisClient();
        await redis.del(`ride:active:${passenger.rideId}`);
      }

      console.log(`🚫 No-show processed: passenger ${passenger._id}`);
    }
  } catch (error) {
    console.error('❌ checkNoShowPassengers error:', error);
  }
};