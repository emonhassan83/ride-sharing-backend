// handlers/driver/driverDropOffPassenger.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { User } from '../../../modules/user/user.model';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import {
  calculateTotalDistance,
  calculateDuration
} from '../../../utils/location.utils';
import { sendNotification } from '../../../utils/sentPushNotification';
import { modeType } from '../../../modules/notification/notification.interface';

export const driverDropOffPassengerHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const redis = getRedisClient();
    const io = getIO();

    const ride = await Ride.findById(rideId);
    if (!ride) return callback?.({ success: false, message: 'Ride not found' });
    if (ride.driverId?.toString() !== driverId)
      return callback?.({ success: false, message: 'You are not assigned to this ride' });
    if (ride.status !== RIDE_STATUS.started)
      return callback?.({ success: false, message: `Cannot drop off — status: ${ride.status}` });

    const locationKey = `ride:${rideId}:live`;
    const locations = await redis.lrange(locationKey, 0, -1);
    const parsedLocations = locations.map((loc: string) => JSON.parse(loc));

    const getPassengerDistance = async (passenger: any) => {
      try {
        const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
          { lat: passenger.pickup.coordinates[1], lng: passenger.pickup.coordinates[0] },
          { lat: passenger.destination.coordinates[1], lng: passenger.destination.coordinates[0] }
        );
        return { distanceKm, durationSeconds: durationMinutes * 60 };
      } catch {
        return {
          distanceKm: calculateTotalDistance(parsedLocations) || passenger.estimatedDistanceKm || 0,
          durationSeconds: calculateDuration(parsedLocations) || 0,
        };
      }
    };

    const dropOffPassenger = async (passenger: any) => {
      const { distanceKm, durationSeconds } = await getPassengerDistance(passenger);

      const waitingCharge = passenger.waitingCharge || 0;
      const baseFare = passenger.estimatedFare || 0;
      const totalFare = baseFare + waitingCharge;

      await Passenger.findByIdAndUpdate(passenger._id, {
        status: PASSENGER_STATUS.dropped_off,
        droppedOffAt: new Date(),
        totalFare,
      });

      await redis.rpush(locationKey, JSON.stringify({
        event: 'PASSENGER_DROPPED_OFF',
        driverId,
        passengerId: passenger._id,
        timestamp: Date.now(),
      }));

      // ── Notification to Passenger ─────────────────────────────────────
      const riderUser = await User.findById(passenger.userId).select('fcmToken').lean();
      if (riderUser?.fcmToken) {
        await sendNotification([riderUser.fcmToken], {
          receiver: passenger.userId,
          message: '🛑 You have been dropped off',
          description: `Total fare: £${totalFare} (Base: £${baseFare} + Waiting: £${waitingCharge})`,
          reference: rideId,
          modelType: modeType.Ride
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

    // PRIVATE RIDE
    if (ride.type === RIDE_TYPE.private) {
      const passenger = passengerId ? await Passenger.findOne({
         _id: passengerId,
        rideId,
        status: PASSENGER_STATUS.picked_up,
      }) : await Passenger.findOne({
        rideId,
        status: PASSENGER_STATUS.picked_up,
      });
      if (!passenger) return callback?.({ success: false, message: 'No picked up passenger found' });

      const result = await dropOffPassenger(passenger);

      return callback?.({
        success: true,
        message: 'Passenger dropped off successfully',
        data: { ...result, allDroppedOff: true },
      });
    }

    // SPLIT RIDE
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId) return callback?.({ success: false, message: 'passengerId is required' });

      const passenger = await Passenger.findOne({
        _id: passengerId,
        rideId,
        status: PASSENGER_STATUS.picked_up,
      });
      if (!passenger) return callback?.({ success: false, message: 'Passenger not found or already dropped off' });

      const result = await dropOffPassenger(passenger);

      const remainingCount = await Passenger.countDocuments({
        rideId,
        status: PASSENGER_STATUS.picked_up,
      });

      io.to(`driver:${driverId}`).emit('ride:passenger-dropped-off', {
        rideId,
        passengerId: passenger._id,
        remainingPassengers: remainingCount,
        message: remainingCount > 0 
          ? `${remainingCount} passenger(s) remaining.` 
          : 'All passengers dropped off.',
      });

      return callback?.({
        success: true,
        message: 'Passenger dropped off successfully',
        data: {
          ...result,
          remainingPassengers: remainingCount,
          allDroppedOff: remainingCount === 0,
        },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  }
);