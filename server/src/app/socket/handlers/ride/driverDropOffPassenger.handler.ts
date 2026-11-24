// handlers/driver/driverDropOffPassenger.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import {
  calculateTotalDistance,
  calculateDuration,
} from '../../../utils/location.utils';
import { notifyUserPush } from '../../../utils/notifyUser.utils';
import { modeType } from '../../../modules/notification/notification.interface';
import { sanitizeText, translateText } from '../../../i18n/i18n';

export const driverDropOffPassengerHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId) {
      return callback?.({
        success: false,
        message: translateText('Missing required fields'),
      });
    }

    const redis = getRedisClient();
    const io = getIO();

    const ride = await Ride.findById(rideId);
    if (!ride) {
      return callback?.({
        success: false,
        message: translateText('Ride not found'),
      });
    }
    if (ride.driverId?.toString() !== driverId) {
      return callback?.({
        success: false,
        message: translateText('You are not assigned to this ride'),
      });
    }
    if (ride.status !== RIDE_STATUS.started) {
      return callback?.({
        success: false,
        message: sanitizeText(`Cannot drop off - status: ${ride.status}`),
      });
    }

    const locationKey = `ride:${rideId}:live`;
    const locations = await redis.lrange(locationKey, 0, -1);
    const parsedLocations = locations.map((loc: string) => JSON.parse(loc));

    const getPassengerDistance = async (passenger: any) => {
      try {
        const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
          {
            lat: passenger.pickup.coordinates[1],
            lng: passenger.pickup.coordinates[0],
          },
          {
            lat: passenger.destination.coordinates[1],
            lng: passenger.destination.coordinates[0],
          },
        );
        return { distanceKm, durationSeconds: durationMinutes * 60 };
      } catch {
        return {
          distanceKm:
            calculateTotalDistance(parsedLocations) ||
            passenger.estimatedDistanceKm ||
            0,
          durationSeconds: calculateDuration(parsedLocations) || 0,
        };
      }
    };

    const dropOffPassenger = async (passenger: any) => {
      const { distanceKm, durationSeconds } =
        await getPassengerDistance(passenger);

      const waitingCharge = 0;
      const baseFare = passenger.estimatedFare || passenger.totalFare || 0;
      const totalFare = baseFare;

      // Atomic: a double tap used to drop off (and notify) the passenger twice (issue 9).
      const transitioned = await Passenger.findOneAndUpdate(
        {
          _id: passenger._id,
          status: PASSENGER_STATUS.picked_up,
        },
        {
          $set: {
            status: PASSENGER_STATUS.dropped_off,
            droppedOffAt: new Date(),
            totalFare,
          },
        },
        { returnDocument: 'after' },
      );
      if (!transitioned) {
        return { totalFare, distanceKm, durationSeconds, alreadyDroppedOff: true };
      }

      await redis.rpush(
        locationKey,
        JSON.stringify({
          event: 'PASSENGER_DROPPED_OFF',
          driverId,
          passengerId: passenger._id,
          timestamp: Date.now(),
        }),
      );

      // Notification to Passenger (clean UTF-8 Euro symbol + auto-localized in notifyUserPush)
      if (passenger.userId) {
        await notifyUserPush({
          userId: passenger.userId.toString(),
          message: 'You have been dropped off',
          description: `Total fare: €${totalFare} (Base: €${baseFare} + Waiting: €${waitingCharge})`,
          reference: String(rideId),
          modelType: modeType.Ride,
          // Shared with driver:complete-trip: the rider gets ONE "trip finished"
          // push with the fare, not "dropped off" + "Trip Completed!" (issue 9).
          dedupeKey: `trip-finished:${passenger._id.toString()}`,
          data: {
            type: 'PASSENGER_DROPPED_OFF',
            rideId: String(rideId),
            passengerId: String(passenger._id),
            totalFare: String(totalFare),
          },
        }).catch(() => {});
      }

      // Socket Event
      io.to(`user:${passenger.userId}`).emit('ride:passenger-dropped-off', {
        rideId,
        passengerId: passenger._id,
        fare: baseFare,
        waitingCharge,
        totalFare,
        distance: distanceKm,
        duration: durationSeconds,
        message: 'You have been dropped off successfully.',
      });

      return { totalFare, distanceKm, durationSeconds };
    };

    // Only a rider who was picked up (driver:pickup-ride, which enforces the
    // start OTP) can be dropped off. `in_progress` only means the driver is on
    // the way (driver:start-trip), so start-trip → drop-off → complete used to
    // finish and charge a trip without the OTP ever being checked.
    const NOT_YET_PICKED_UP = [
      PASSENGER_STATUS.confirmed,
      PASSENGER_STATUS.in_progress,
      PASSENGER_STATUS.driver_arrived,
    ];
    const pickupRequired = (passenger: any) =>
      callback?.({
        success: false,
        code: 'PICKUP_REQUIRED',
        requiresOtp: true,
        message: translateText('Pick up the passenger (with the ride start OTP) before drop-off'),
        data: { rideId, passengerId: passenger._id },
      });

    // PRIVATE RIDE
    if (ride.type === RIDE_TYPE.private) {
      const passenger = passengerId
        ? await Passenger.findOne({
            _id: passengerId,
            rideId,
            status: PASSENGER_STATUS.picked_up,
          })
        : await Passenger.findOne({
            rideId,
            status: PASSENGER_STATUS.picked_up,
          });
      if (!passenger) {
        const waiting = await Passenger.findOne({
          ...(passengerId ? { _id: passengerId } : {}),
          rideId,
          status: { $in: NOT_YET_PICKED_UP },
        });
        if (waiting) return pickupRequired(waiting);
        return callback?.({
          success: false,
          message: translateText('No picked up passenger found'),
        });
      }

      const result = await dropOffPassenger(passenger);

      return callback?.({
        success: true,
        message: translateText('Passenger dropped off successfully'),
        data: { ...result, allDroppedOff: true },
      });
    }

    // SPLIT RIDE
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId) {
        return callback?.({
          success: false,
          message: translateText('passengerId is required'),
        });
      }

      const passenger = await Passenger.findOne({
        _id: passengerId,
        rideId,
        status: PASSENGER_STATUS.picked_up,
      });
      if (!passenger) {
        const waiting = await Passenger.findOne({
          _id: passengerId,
          rideId,
          status: { $in: NOT_YET_PICKED_UP },
        });
        if (waiting) return pickupRequired(waiting);
        return callback?.({
          success: false,
          message: translateText('Passenger not found or already dropped off'),
        });
      }

      const result = await dropOffPassenger(passenger);

      // Riders still on this trip: on board, or not yet picked up.
      const remainingCount = await Passenger.countDocuments({
        rideId,
        status: { $in: [PASSENGER_STATUS.picked_up, ...NOT_YET_PICKED_UP] },
      });

      io.to(`driver:${driverId}`).emit('ride:passenger-dropped-off', {
        rideId,
        passengerId: passenger._id,
        remainingPassengers: remainingCount,
        message:
          remainingCount > 0
            ? `${remainingCount} passenger(s) remaining.`
            : 'All passengers dropped off.',
      });

      return callback?.({
        success: true,
        message: translateText('Passenger dropped off successfully'),
        data: {
          ...result,
          remainingPassengers: remainingCount,
          allDroppedOff: remainingCount === 0,
        },
      });
    }

    return callback?.({
      success: false,
      message: translateText('Unknown ride type'),
    });
  },
);
