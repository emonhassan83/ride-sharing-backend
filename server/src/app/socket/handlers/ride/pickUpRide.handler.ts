// handlers/driver/pickUpRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

export const pickUpRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });

    if (ride.driverId?.toString() !== driverId)
      return callback?.({ success: false, message: 'You are not assigned to this ride' });

    if (ride.status !== RIDE_STATUS.started)
      return callback?.({ success: false, message: 'Trip must be started before picking up passengers' });

    const redis = getRedisClient();
    const io    = getIO();

    // ── PRIVATE RIDE — pick up the only passenger ─────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId,
        status: PASSENGER_STATUS.in_progress,
      });

      if (!passenger)
        return callback?.({ success: false, message: 'No passenger to pick up' });

      passenger.status      = PASSENGER_STATUS.picked_up;
      passenger.pickedUpAt  = new Date();
      await passenger.save();

      await redis.rpush(
        `ride:${rideId}:live`,
        JSON.stringify({
          event:          'PASSENGER_PICKED_UP',
          driverId,
          passengerId:    passenger._id,
          timestamp:      Date.now()
        }),
      );

      io.to(`ride:${rideId}`).emit('ride:passenger-picked-up', {
        rideId,
        passengerId: passenger._id,
        driverId,
        pickedUpAt:  new Date(),
        message:     'You have been picked up!',
      });

      io.to(`ride:${rideId}`).emit('ride:all-passengers-picked', {
        rideId,
        message:        'All passengers have been picked up.',
        passengerCount: 1,
      });

      console.log(`✅ Private passenger picked up | rideId: ${rideId}`);

      return callback?.({
        success: true,
        message: 'Passenger picked up successfully',
        data:    { passengerId: passenger._id, allPickedUp: true },
      });
    }

    // ── SPLIT RIDE — single passenger pickup (passengerId required) ───────────
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required for split ride' });

      const passenger = await Passenger.findOne({
        _id:    passengerId,
        rideId,
        status: PASSENGER_STATUS.in_progress,
      });

      if (!passenger)
        return callback?.({ success: false, message: 'Passenger not found or already picked up' });

      passenger.status      = PASSENGER_STATUS.picked_up;
      passenger.pickedUpAt  = new Date();
      await passenger.save();

      await redis.rpush(
        `ride:${rideId}:live`,
        JSON.stringify({
          event:          'PASSENGER_PICKED_UP',
          driverId,
          passengerId:    passenger._id,
          timestamp:      Date.now()
        }),
      );

      // Notify picked passenger
      io.to(`user:${passenger.userId}`).emit('ride:passenger-picked-up', {
        rideId,
        passengerId: passenger._id,
        driverId,
        pickedUpAt:  new Date(),
        message:     'You have been picked up!',
      });

      // Remaining in_progress passengers
      const remainingCount = await Passenger.countDocuments({
        rideId,
        status: PASSENGER_STATUS.in_progress,
      });

      if (remainingCount > 0) {
        // Notify remaining passengers
        const otherPassengers = await Passenger.find({
          rideId,
          _id:    { $ne: passengerId },
          status: PASSENGER_STATUS.in_progress,
        }).select('userId');

        for (const op of otherPassengers) {
          io.to(`user:${op.userId}`).emit('ride:co-passenger-picked', {
            rideId,
            pickedUpPassengerId: passenger._id,
            remainingPassengers: remainingCount,
            message:             'A fellow passenger has been picked up.',
          });
        }

        // Notify driver
        io.to(`driver:${driverId}`).emit('ride:passenger-picked', {
          rideId,
          passengerId:         passenger._id,
          remainingPassengers: remainingCount,
          message:             `${remainingCount} passenger(s) remaining to pick up.`,
        });

        console.log(`✅ Passenger picked up | rideId: ${rideId} | remaining: ${remainingCount}`);

        return callback?.({
          success: true,
          message: `Passenger picked up. ${remainingCount} passenger(s) remaining.`,
          data: {
            passengerId:         passenger._id,
            remainingPassengers: remainingCount,
            allPickedUp:         false,
          },
        });
      }

      // All picked up
      io.to(`ride:${rideId}`).emit('ride:all-passengers-picked', {
        rideId,
        message: 'All passengers have been picked up.',
      });

      console.log(`✅ Last passenger picked up | rideId: ${rideId}`);

      return callback?.({
        success: true,
        message: 'Last passenger picked up. All passengers on board!',
        data: {
          passengerId:         passenger._id,
          remainingPassengers: 0,
          allPickedUp:         true,
        },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  },
);