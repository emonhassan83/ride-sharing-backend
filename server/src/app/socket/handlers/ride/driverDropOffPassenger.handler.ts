// handlers/driver/driverDropOffPassenger.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import {
  calculateTotalDistance,
  calculateDuration,
  calculateFareFromDistance,
} from '../../../utils/location.utils';

export const driverDropOffPassengerHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const redis = getRedisClient();
    const io    = getIO();

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });
    if (ride.driverId?.toString() !== driverId)
      return callback?.({ success: false, message: 'You are not assigned to this ride' });
    if (ride.status !== RIDE_STATUS.started)
      return callback?.({ success: false, message: `Cannot drop off — status: ${ride.status}` });

    const locationKey     = `ride:${rideId}:live`;
    const locations       = await redis.lrange(locationKey, 0, -1);
    const parsedLocations = locations.map((loc: string) => JSON.parse(loc));

    const getPassengerDistance = async (passenger: any) => {
      try {
        const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
          { lat: passenger.pickup.coordinates[1],      lng: passenger.pickup.coordinates[0] },
          { lat: passenger.destination.coordinates[1], lng: passenger.destination.coordinates[0] },
        );
        return { distanceKm, durationSeconds: durationMinutes * 60 };
      } catch {
        return {
          distanceKm:      calculateTotalDistance(parsedLocations) || passenger.estimatedDistanceKm || 0,
          durationSeconds: calculateDuration(parsedLocations) || 0,
        };
      }
    };

    const dropOffPassenger = async (passenger: any) => {
      const { distanceKm, durationSeconds } = await getPassengerDistance(passenger);

      // ✅ Bug 3 fix: waitingCharge from passenger model, not from client data
      const waitingCharge = passenger.waitingCharge || 0;
      const baseFare      = passenger.estimatedFare || calculateFareFromDistance(distanceKm);
      const totalFare     = baseFare + waitingCharge;

      passenger.totalFare    = totalFare;
      passenger.status       = PASSENGER_STATUS.dropped_off;
      passenger.droppedOffAt = new Date();
      await passenger.save();

      await redis.rpush(`ride:${rideId}:live`, JSON.stringify({
        event:       'WAYPOINT',
        note:        'PASSENGER_DROPPED_OFF',
        driverId,
        passengerId: passenger._id,
        timestamp:   Date.now(),
      }));

      io.to(`user:${passenger.userId}`).emit('ride:passenger-dropped-off', {
        rideId,
        passengerId:  passenger._id,
        fare:         baseFare,
        waitingCharge,
        totalFare,
        distance:     distanceKm,
        duration:     durationSeconds,
        message:      'You have been dropped off. Please wait for trip completion.',
      });

      return { totalFare, distanceKm, durationSeconds };
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId,
        status: PASSENGER_STATUS.picked_up, // ✅ Bug 2 fix: picked_up not in_progress
      });
      if (!passenger)
        return callback?.({ success: false, message: 'No picked up passenger found' });

      const { totalFare, distanceKm, durationSeconds } = await dropOffPassenger(passenger);

      return callback?.({
        success: true,
        message: 'Passenger dropped off. Complete the ride to finish.',
        data:    { passengerId: passenger._id, fare: totalFare, distance: distanceKm, duration: durationSeconds, allDroppedOff: true },
      });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required for split ride' });

      const passenger = await Passenger.findOne({
        _id: passengerId, rideId,
        status: PASSENGER_STATUS.picked_up, // ✅ correct
      });
      if (!passenger)
        return callback?.({ success: false, message: 'Passenger not found or already dropped off' });

      const { totalFare, distanceKm, durationSeconds } = await dropOffPassenger(passenger);

      const remainingCount = await Passenger.countDocuments({
        rideId, status: PASSENGER_STATUS.picked_up,
      });
      const allDroppedOff = remainingCount === 0;

      io.to(`driver:${driverId}`).emit('ride:passenger-dropped-off', {
        rideId,
        passengerId:         passenger._id,
        remainingPassengers: remainingCount,
        allDroppedOff,
        message: allDroppedOff
          ? 'All passengers dropped off. You can now complete the ride.'
          : `Passenger dropped off. ${remainingCount} remaining.`,
      });

      return callback?.({
        success: true,
        message: allDroppedOff
          ? 'All passengers dropped off. Complete the ride to finish.'
          : `Passenger dropped off. ${remainingCount} passenger(s) remaining.`,
        data: { passengerId: passenger._id, fare: totalFare, distance: distanceKm, duration: durationSeconds, remainingPassengers: remainingCount, allDroppedOff },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  },
);