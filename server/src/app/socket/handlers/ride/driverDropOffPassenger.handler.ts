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
    const {
      rideId,
      passengerId,
      waitingCharge = 0
    } = data;
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
      return callback?.({ success: false, message: `Cannot drop off — ride status: ${ride.status}` });

    // ── Location history from Redis ───────────────────────────────────────────
    const locationKey     = `ride:${rideId}:live`;
    const locations       = await redis.lrange(locationKey, 0, -1);
    const parsedLocations = locations.map((loc: string) => JSON.parse(loc));

    // ── Get real distance from passenger pickup → destination ─────────────────
    const getPassengerDistance = async (passenger: any) => {
      const pickupLat = passenger.pickup.coordinates[1];
      const pickupLng = passenger.pickup.coordinates[0];
      const destLat   = passenger.destination.coordinates[1];
      const destLng   = passenger.destination.coordinates[0];

      try {
        const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
          { lat: pickupLat, lng: pickupLng },
          { lat: destLat,   lng: destLng   },
        );
        return { distanceKm, durationSeconds: durationMinutes * 60 };
      } catch {
        const distanceKm      = calculateTotalDistance(parsedLocations) || passenger.estimatedDistanceKm || 0;
        const durationSeconds = calculateDuration(parsedLocations) || 0;
        return { distanceKm, durationSeconds };
      }
    };

    // ── Helper: drop off single passenger ─────────────────────────────────────
    const dropOffPassenger = async (passenger: any) => {
      const { distanceKm, durationSeconds } = await getPassengerDistance(passenger);

      const baseFare  = passenger.estimatedFare || calculateFareFromDistance(distanceKm);
      const totalFare = baseFare + waitingCharge;

      // ── Update passenger → dropped_off ────────────────────────────────────
      passenger.totalFare   = totalFare;
      passenger.status      = PASSENGER_STATUS.dropped_off;
      passenger.droppedOffAt = new Date();
      if (waitingCharge) passenger.waitingCharge = waitingCharge;
      await passenger.save();

      // ── Redis log ─────────────────────────────────────────────────────────
      await redis.rpush(
        `ride:${rideId}:live`,
        JSON.stringify({
          event:       'WAYPOINT',
          note:        'PASSENGER_DROPPED_OFF',
          driverId,
          passengerId: passenger._id,
          timestamp:   Date.now(),
        }),
      );

      // ── Notify passenger — dropped off ────────────────────────────────────
      io.to(`user:${passenger.userId}`).emit('ride:passenger-dropped-off', {
        rideId,
        passengerId: passenger._id,
        fare:        totalFare,
        distance:    distanceKm,
        duration:    durationSeconds,
        waitingCharge,
        message:     'You have been dropped off. Please wait for trip completion.',
      });

      return { totalFare, distanceKm, durationSeconds };
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId,
        status: PASSENGER_STATUS.picked_up,
      });
      if (!passenger)
        return callback?.({ success: false, message: 'No active passenger found' });

      const { totalFare, distanceKm, durationSeconds } = await dropOffPassenger(passenger);

      return callback?.({
        success: true,
        message: 'Passenger dropped off. Complete the ride to finish.',
        data: {
          passengerId:  passenger._id,
          fare:         totalFare,
          distance:     distanceKm,
          duration:     durationSeconds,
          allDroppedOff: true,
        },
      });
    }

    // ── SPLIT RIDE — single passenger drop off ────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required for split ride' });

      const passenger = await Passenger.findOne({
        _id:    passengerId,
        rideId,
        status: PASSENGER_STATUS.picked_up,
      });
      if (!passenger)
        return callback?.({ success: false, message: 'Passenger not found or already dropped off' });

      const { totalFare, distanceKm, durationSeconds } = await dropOffPassenger(passenger);

      // Check remaining in_progress passengers
      const remainingCount = await Passenger.countDocuments({
        rideId,
        status: PASSENGER_STATUS.picked_up,
      });
      const allDroppedOff = remainingCount === 0;

      // Notify driver
      io.to(`driver:${driverId}`).emit('ride:passenger-dropped-off', {
        rideId,
        passengerId:      passenger._id,
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
        data: {
          passengerId:      passenger._id,
          fare:             totalFare,
          distance:         distanceKm,
          duration:         durationSeconds,
          remainingPassengers: remainingCount,
          allDroppedOff,
        },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  },
);