// handlers/driver/pickUpRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

/* 
দায়িত্ব: নির্দিষ্ট passenger(s) কে physically pickup করা (status → picked_up)
Client payload:
single: { rideId, passengerId, pickupOdometer? }
all:    { rideId, pickupType: 'all', pickupOdometer? }
*/

export const pickUpRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, pickupType = 'single', pickupOdometer } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId) {
      return callback?.({ success: false, message: 'Missing required fields' });
    }

    try {
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
      if (ride.status !== RIDE_STATUS.started) {
        return callback?.({
          success: false,
          message: 'Trip must be started before picking up passengers',
        });
      }

      const redis = getRedisClient();
      const io = getIO();

      // ═══════════════════════════════════════════════════════════════
      // CASE 1: Private ride OR pickupType = 'all' — সবাইকে pickup
      // ═══════════════════════════════════════════════════════════════
      if (ride.type === RIDE_TYPE.private || pickupType === 'all') {
        const passengers = await Passenger.find({
          rideId,
          status: PASSENGER_STATUS.in_progress,
        });

        if (!passengers.length) {
          return callback?.({
            success: false,
            message: 'No passengers to pick up',
          });
        }

        for (const passenger of passengers) {
          passenger.status = PASSENGER_STATUS.picked_up;
          passenger.pickedUpAt = new Date();
          if (pickupOdometer) passenger.pickupOdometer = pickupOdometer;
          await passenger.save();

          // Notify each passenger
          io.to(`ride:${rideId}`).emit('ride:passenger-picked-up', {
            rideId,
            passengerId: passenger._id,
            driverId,
            pickedUpAt: new Date(),
            message: 'You have been picked up!',
          });
        }

        // Redis log
        await redis.rpush(
          `ride:${rideId}:live`,
          JSON.stringify({
            event: 'ALL_PASSENGERS_PICKED_UP',
            driverId,
            passengerCount: passengers.length,
            timestamp: Date.now(),
            pickupOdometer: pickupOdometer || 0,
          })
        );

        // Broadcast to ride room
        io.to(`ride:${rideId}`).emit('ride:all-passengers-picked', {
          rideId,
          message: 'All passengers have been picked up.',
          passengerCount: passengers.length,
        });

        console.log(
          `✅ All passengers picked up | rideId: ${rideId} | count: ${passengers.length}`
        );

        return callback?.({
          success: true,
          message: 'All passengers picked up successfully',
          data: {
            passengerCount: passengers.length,
          allPickedUp: true,
          }
        });
      }

      // ═══════════════════════════════════════════════════════════════
      // CASE 2: Split ride — single passenger pickup
      // ═══════════════════════════════════════════════════════════════
      if (pickupType === 'single' && passengerId) {
        const passenger = await Passenger.findOne({
          _id: passengerId,
          rideId,
          status: PASSENGER_STATUS.in_progress,
        });

        if (!passenger) {
          return callback?.({
            success: false,
            message: 'Passenger not found or already picked up',
          });
        }

        passenger.status = PASSENGER_STATUS.picked_up;
        passenger.pickedUpAt = new Date();
        if (pickupOdometer) passenger.pickupOdometer = pickupOdometer;
        await passenger.save();

        // Redis log
        await redis.rpush(
          `ride:${rideId}:live`,
          JSON.stringify({
            event: 'PASSENGER_PICKED_UP',
            driverId,
            passengerId: passenger._id,
            timestamp: Date.now(),
            pickupOdometer: pickupOdometer || 0,
          })
        );

        // Notify picked passenger
        io.to(`ride:${rideId}`).emit('ride:passenger-picked-up', {
          rideId,
          passengerId: passenger._id,
          driverId,
          pickedUpAt: new Date(),
          message: 'You have been picked up!',
        });

        // Remaining passengers still in_progress
        const remainingCount = await Passenger.countDocuments({
          rideId,
          status: PASSENGER_STATUS.in_progress,
        });

        if (remainingCount > 0) {
          // Notify other in_progress passengers
          const otherPassengers = await Passenger.find({
            rideId,
            _id: { $ne: passengerId },
            status: PASSENGER_STATUS.in_progress,
          }).select('userId');

          for (const op of otherPassengers) {
            io.to(`ride:${rideId}`).emit('ride:co-passenger-picked', {
              rideId,
              pickedUpPassengerId: passenger._id,
              remainingPassengers: remainingCount,
              message: 'A fellow passenger has been picked up.',
            });
          }

          // Notify driver how many left
          io.to(`driver:${driverId}`).emit('ride:passenger-picked', {
            rideId,
            passengerId: passenger._id,
            remainingPassengers: remainingCount,
            message: `${remainingCount} passenger(s) remaining to pick up.`,
          });

          console.log(
            `✅ Passenger picked up | rideId: ${rideId} | remaining: ${remainingCount}`
          );

          return callback?.({
            success: true,
            message: `Passenger picked up. ${remainingCount} passenger(s) remaining.`,
            data: {
              passengerId: passenger._id,
            remainingPassengers: remainingCount,
            allPickedUp: false,
            }
          });
        }

        // সবাই picked up — notify all
        io.to(`ride:${rideId}`).emit('ride:all-passengers-picked', {
          rideId,
          message: 'All passengers have been picked up.',
        });

        console.log(`✅ Last passenger picked up | rideId: ${rideId}`);

        return callback?.({
          success: true,
          message: 'Last passenger picked up. All passengers on board!',
          data: {
            passengerId: passenger._id,
            remainingPassengers: 0,
            allPickedUp: true,
          }
        });
      }

      return callback?.({
        success: false,
        message: 'Invalid pickupType or missing passengerId for single pickup',
      });
    } catch (error) {
      console.error('❌ Error in pickUpRideHandler:', error);
      return callback?.({ success: false, message: 'Internal server error' });
    }
  }
);
