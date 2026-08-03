// handlers/driver/driverRejectRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import {
  RIDE_STATUS,
  RIDE_TYPE,
  CANCELLED_BY,
} from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { recalculateSplitFares } from '../../../utils/splitFare.utils';

export const driverRejectRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, reason = '' } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const ride = await Ride.findById(rideId);
    if (!ride || ride.status !== RIDE_STATUS.pending)
      return callback?.({
        success: false,
        message: 'Ride already accepted or cancelled',
      });

    const redis = getRedisClient();
    const io = getIO();

    // â”€â”€ Helper: add driver to rejected list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const markRejected = async () => {
      await redis.sadd(`ride:rejected:${rideId}`, driverId);
      const departureMs = new Date(`${ride.departureDate}T${ride.departureTime}:00`).getTime();
      const ttlSeconds = Math.max(
        1800,
        Math.floor((departureMs - Date.now()) / 1000) + 7200
      );
      await redis.expire(`ride:rejected:${rideId}`, ttlSeconds);
    };

    // â”€â”€ Helper: redis cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const redisCleanup = async () => {
      await Promise.all([
        redis.zrem('ride:matching:queue', rideId),
        redis.del(`ride:request:${rideId}`),
      ]);
    };

    // â”€â”€ PRIVATE RIDE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (ride.type === RIDE_TYPE.private) {
      const passenger = passengerId
        ? await Passenger.findOne({
            _id: passengerId,
            rideId,
            status: PASSENGER_STATUS.pending,
          })
        : await Passenger.findOne({ rideId, status: PASSENGER_STATUS.pending });
      if (!passenger) {
        return callback?.({
          success: false,
          message: 'Passenger not found or already processed',
        });
      }

      if (passenger) {
        io.to(`user:${passenger.userId}`).emit('ride:driver-rejected', {
          rideId,
          passengerId: passenger._id,
          reason: reason || 'Driver is busy',
          searchingAgain: true,
          rideCancelled: false,
        });
      }

      await markRejected();

      await Ride.findByIdAndUpdate(rideId, {
        $unset: {
          driverId: '',
          vehicleId: '',
        },
      });

      await redis.hset(`ride:request:${rideId}`, {
        matchingStatus: 'driver_rejected_waiting_for_fallback',
        lastRejectedDriverId: driverId,
        lastRejectedAt: Date.now().toString(),
      });

      return callback?.({
        success: true,
        message: 'Private ride rejection recorded. Ride remains pending for fallback matching.',
        data: { passengerCount: passenger ? 1 : 0, rideCancelled: false },
      });
    }

    // â”€â”€ SPLIT RIDE â€” passengerId required â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({
          success: false,
          message: 'passengerId is required for split ride',
        });

      const passenger = await Passenger.findOne({
        _id: passengerId,
        rideId,
        status: PASSENGER_STATUS.pending,
      });
      if (!passenger)
        return callback?.({
          success: false,
          message: 'Passenger not found or already processed',
        });

      // Reject this passenger
      passenger.status = PASSENGER_STATUS.rejected;
      passenger.rejectionReason = reason || 'Driver rejected';
      await passenger.save();

      io.to(`user:${passenger.userId}`).emit('ride:driver-rejected', {
        rideId,
        passengerId: passenger._id,
        reason: reason || 'Driver rejected your request',
        searchingAgain: true,
        rideCancelled: false,
      });

      await markRejected();

      // âœ… Case 6: Recalculate remaining passengers' fares
      if (ride.type === RIDE_TYPE.split) {
        await recalculateSplitFares(rideId, 'passenger_rejected', io);
      }

      // Check remaining pending passengers
      const remainingCount = await Passenger.countDocuments({
        rideId,
        status: PASSENGER_STATUS.pending,
      });

      if (remainingCount === 0) {
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: 'No passengers left after driver rejection',
          cancelledBy: CANCELLED_BY.system,
          cancelledAt: new Date(),
        });
        await redisCleanup();
        console.log(`Ride ${rideId} cancelled â€” no passengers left`);
      }

      return callback?.({
        success: true,
        message: 'Passenger rejected successfully',
        data: {
          passengerId: passenger._id,
          remainingPassengers: remainingCount,
          rideCancelled: remainingCount === 0,
        },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  }
);




