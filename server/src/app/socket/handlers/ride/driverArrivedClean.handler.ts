// handlers/ride/driverArrivedClean.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { triggerArrival } from '../../utils/triggerArrival';

export const driverArrivedHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, lat = 0, lng = 0 } = data || {};
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId) {
      return callback?.({
        success: false,
        message: 'Missing required fields: rideId',
      });
    }

    const ride = await Ride.findById(rideId);
    if (!ride) {
      return callback?.({ success: false, message: 'Ride not found' });
    }

    if (ride.driverId?.toString() !== driverId) {
      return callback?.({
        success: false,
        message: 'You are not assigned to this ride',
      });
    }

    if (
      ride.status !== RIDE_STATUS.accepted &&
      ride.status !== RIDE_STATUS.started
    ) {
      return callback?.({
        success: false,
        message: `Cannot mark arrival for ride in ${ride.status} status`,
      });
    }

    const io = getIO();
    const redis = getRedisClient();

    const passengerQuery: Record<string, any> = {
      rideId,
      status: {
        $in: [
          PASSENGER_STATUS.confirmed,
          PASSENGER_STATUS.in_progress,
          PASSENGER_STATUS.driver_arrived,
        ],
      },
    };
    if (passengerId) {
      passengerQuery._id = passengerId;
    }

    const passengers = await Passenger.find(passengerQuery);
    if (!passengers.length) {
      return callback?.({
        success: false,
        message: 'No confirmed passenger found for arrival notification',
      });
    }

    for (const passenger of passengers) {
      await triggerArrival(
        String(rideId),
        passenger._id,
        driverId,
        Number(lat) || 0,
        Number(lng) || 0,
        io,
        redis,
      );
    }

    return callback?.({
      success: true,
      message: 'Driver arrival marked and passenger notified successfully.',
      data: {
        rideId: ride._id,
        passengerIds: passengers.map((p) => p._id),
      },
    });
  },
);

