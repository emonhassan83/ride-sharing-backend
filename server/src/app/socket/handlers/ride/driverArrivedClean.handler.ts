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
import { sendRideStartOtp } from '../../../utils/rideStartOtp.utils';

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
        $in: [PASSENGER_STATUS.confirmed, PASSENGER_STATUS.driver_arrived],
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

      // Ensure Ride Start OTP is sent when driver explicitly marks arrival
      await sendRideStartOtp({
        rideId: String(rideId),
        passengerId: passenger._id.toString(),
        requesterId: driverId,
        requesterRole: 'provider',
      }).catch(() => {});
    }

    return callback?.({
      success: true,
      message:
        'Arrival marked and Ride Start OTP sent to passenger notification and email.',
      data: {
        rideId: ride._id,
        passengerIds: passengers.map((p) => p._id),
      },
    });
  },
);

