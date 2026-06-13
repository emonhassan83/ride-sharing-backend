// jobs/noShowPassengers.job.ts
import { getRedisClient } from '../config/redis.config';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { Passenger } from '../modules/passenger/passenger.model';
import { Ride } from '../modules/ride/ride.model';
import { RIDE_STATUS } from '../modules/ride/ride.constant';
import { Setting } from '../modules/settings/settings.model';
import { getIO } from '../socket/socket.init';
import { recalculateSplitFares } from '../utils/splitFare.utils';

const BATCH_SIZE = 50;

export const checkNoShowPassengers = async (): Promise<void> => {
  try {
    const io      = getIO();
    const setting = await Setting.findOne({ key: 'waitingTimeMinutes' }).lean();
    const waitMin = Number(setting?.value ?? 15);
    const cutoff  = new Date(Date.now() - waitMin * 60 * 1000);

    // Find passengers in driver_arrived too long (Case 16)
    const noShows = await Passenger.find({
      status:          PASSENGER_STATUS.driver_arrived,
      arriveAt:        { $lte: cutoff },
      isNoShow:        { $ne: true },
      pickedUpAt:      null,
    })
      .limit(BATCH_SIZE)
      .lean();

    if (!noShows.length) return;

    for (const passenger of noShows) {
      // ── Mark no-show — NO refund, NO waiting charge (Case 16) ────────────
      await Passenger.findByIdAndUpdate(passenger._id, {
        status:             PASSENGER_STATUS.cancelled,
        isNoShow:           true,
        cancellationReason: 'no_show',
        cancelledBy:        'system',
      });

      io.to(`user:${passenger.userId}`).emit('ride:no-show', {
        rideId:      passenger.rideId,
        passengerId: passenger._id,
        message:     'You were marked as no-show. No refund will be issued.',
      });

      if (passenger.rideId) {
        const ride = await Ride.findById(passenger.rideId)
          .select('driverId type bookedSeats totalSeats')
          .lean();

        if (ride?.driverId) {
          io.to(`driver:${ride.driverId}`).emit('ride:passenger-no-show', {
            rideId:      passenger.rideId,
            passengerId: passenger._id,
            message:     'Passenger no-show. You may proceed.',
          });
        }

        // Decrement seats
        await Ride.findByIdAndUpdate(passenger.rideId, {
          $inc: { bookedSeats: -(passenger.requestedSeats || 1) },
        });

        // Recalculate remaining (Case 16 — surcharge tier may change)
        if ((ride as any)?.type === 'split') {
          await recalculateSplitFares(passenger.rideId.toString(), 'passenger_cancelled', io);
        }

        // Cancel ride if no passengers left
        const remaining = await Passenger.countDocuments({
          rideId: passenger.rideId,
          status: { $nin: [RIDE_STATUS.cancelled, RIDE_STATUS.rejected] },
        });

        if (remaining === 0) {
          await Ride.findByIdAndUpdate(passenger.rideId, {
            status:             RIDE_STATUS.cancelled,
            cancellationReason: 'all_passengers_no_show',
          });
          const redis = getRedisClient();
          await redis.del(`ride:active:${passenger.rideId}`);
        }
      }

      console.log(`🚫 No-show: passenger ${passenger._id}`);
    }
  } catch (error) {
    console.error('❌ checkNoShowPassengers error:', error);
  }
};