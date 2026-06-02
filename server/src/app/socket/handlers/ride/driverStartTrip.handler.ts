// handlers/driver/driverStartTrip.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

/**
 * driver:start-trip Handler
 *
 * কেস ১: প্রাইভেট রাইড → পুরো রাইড একবারেই start
 * কেস ২: স্প্লিট রাইড – নির্দিষ্ট প্যাসেঞ্জার পিকআপ (startType = 'single' + passengerId)
 * কেস ৩: স্প্লিট রাইড – সব প্যাসেঞ্জার একসাথে পিকআপ (startType = 'all')
 */
export const driverStartTripHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    let { rideId, passengerId, startOdometer, startType = 'single' } = data;
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

      const allowedStates: string[] = [
        RIDE_STATUS.accepted,
        RIDE_STATUS.driver_arrived,
      ];
      if (!allowedStates.includes(ride.status)) {
        return callback?.({
          success: false,
          message: 'Ride cannot be started in current state',
        });
      }

      const redis = getRedisClient();
      const io = getIO();

      // ========== কেস ১: প্রাইভেট রাইড ==========
      if (ride.type === RIDE_TYPE.private) {
        const passenger = await Passenger.findOne({
          rideId,
          status: PASSENGER_STATUS.matched,
        });
        if (!passenger) {
          return callback?.({
            success: false,
            message: 'No matched passenger found',
          });
        }

        // প্যাসেঞ্জার আপডেট
        passenger.status = PASSENGER_STATUS.picked_up;
        passenger.pickedUpAt = new Date();
        await passenger.save();

        // বুকিং আপডেট
        await Booking.findOneAndUpdate(
          { passengerId: passenger._id },
          { bookingStatus: BOOKING_STATUS.running }
        );

        // রাইড স্ট্যাটাস আপডেট
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.in_progress,
          tripStartedAt: new Date(),
          startOdometer: startOdometer || 0,
        });

        // Redis ইভেন্ট লগ
        await redis.rpush(
          `ride:${rideId}:live`,
          JSON.stringify({
            event: 'TRIP_STARTED',
            driverId,
            passengerId: passenger._id,
            timestamp: Date.now(),
            startOdometer: startOdometer || 0,
          })
        );

        // ড্রাইভারের activeRide Redis-এ সেভ
        await redis.set(`driver:${driverId}:activeRide`, rideId);
        await redis.expire(`driver:${driverId}:activeRide`, 7200);

        // প্যাসেঞ্জার নোটিফিকেশন
        io.to(`user:${passenger.userId}`).emit('ride:trip-started', {
          rideId,
          passengerId: passenger._id,
          driverId,
          startTime: new Date(),
          message: 'Your private ride has started. Enjoy the trip!',
        });

        // রাইড রুমে ব্রডকাস্ট
        io.to(`ride:${rideId}`).emit('ride:status-update', {
          rideId,
          status: 'in_progress',
          startedAt: new Date(),
          allPassengersPickedUp: true,
        });

        return callback?.({
          success: true,
          message: 'Private ride started successfully',
          passengerCount: 1,
          allPickedUp: true,
        });
      }

      // ========== কেস ২: স্প্লিট – নির্দিষ্ট প্যাসেঞ্জার পিকআপ ==========
      if (startType === 'single' && passengerId) {
        const passenger = await Passenger.findOne({
          _id: passengerId,
          rideId,
          status: PASSENGER_STATUS.matched,
        });
        if (!passenger) {
          return callback?.({
            success: false,
            message: 'Passenger not found or already picked up',
          });
        }

        // এই প্যাসেঞ্জার পিকআপ আপডেট
        passenger.status = PASSENGER_STATUS.picked_up;
        passenger.pickedUpAt = new Date();
        await passenger.save();

        // বুকিং আপডেট
        await Booking.findOneAndUpdate(
          { passengerId: passenger._id },
          { bookingStatus: BOOKING_STATUS.running }
        );

        // Redis ইভেন্ট লগ
        await redis.rpush(
          `ride:${rideId}:live`,
          JSON.stringify({
            event: 'PASSENGER_PICKED_UP',
            driverId,
            passengerId: passenger._id,
            timestamp: Date.now(),
            startOdometer: startOdometer || 0,
          })
        );

        // প্রথম পিকআপ হলে startOdometer সেভ করি (যদি আগে না থাকে)
        const currentRide = await Ride.findById(rideId);
        if (!currentRide?.startOdometer && startOdometer) {
          await Ride.findByIdAndUpdate(rideId, { startOdometer });
        }

        // অন্য প্যাসেঞ্জারদের নোটিফিকেশন
        const otherPassengers = await Passenger.find({
          rideId,
          _id: { $ne: passengerId },
          status: PASSENGER_STATUS.matched,
        }).select('userId');
        for (const op of otherPassengers) {
          io.to(`user:${op.userId}`).emit('ride:co-passenger-picked', {
            rideId,
            pickedUpPassengerId: passenger._id,
            remainingPassengers: otherPassengers.length,
            message: 'A fellow passenger has been picked up.',
          });
        }

        // বাকি প্যাসেঞ্জার সংখ্যা
        const remainingPassengers = await Passenger.countDocuments({
          rideId,
          status: PASSENGER_STATUS.matched,
        });
        const allPickedUp = remainingPassengers === 0;

        if (allPickedUp) {
          // সব প্যাসেঞ্জার পিক হয়ে গেলে রাইড সম্পূর্ণ start
          await Ride.findByIdAndUpdate(rideId, {
            status: RIDE_STATUS.in_progress,
            tripStartedAt: new Date(),
          });

          await redis.set(`driver:${driverId}:activeRide`, rideId);
          await redis.expire(`driver:${driverId}:activeRide`, 7200);

          // সব প্যাসেঞ্জারকে জানান যে সবাই উঠে গেছে
          const allPassengers = await Passenger.find({
            rideId,
            status: PASSENGER_STATUS.picked_up,
          }).select('userId');
          for (const p of allPassengers) {
            io.to(`user:${p.userId}`).emit('ride:all-passengers-picked', {
              rideId,
              message:
                'All passengers have been picked up. Ride is in progress.',
            });
          }

          io.to(`ride:${rideId}`).emit('ride:status-update', {
            rideId,
            status: 'in_progress',
            startedAt: new Date(),
            allPassengersPickedUp: true,
          });
        } else {
          // ড্রাইভারকে বাকি প্যাসেঞ্জার সংখ্যা জানান
          io.to(`driver:${driverId}`).emit('ride:passenger-picked', {
            rideId,
            passengerId: passenger._id,
            remainingPassengers,
            message: `${remainingPassengers} passenger(s) remaining to pick up.`,
          });
        }

        // প্যাসেঞ্জারকে নোটিফিকেশন
        io.to(`user:${passenger.userId}`).emit('ride:trip-started', {
          rideId,
          passengerId: passenger._id,
          driverId,
          startTime: new Date(),
          message: allPickedUp
            ? 'You have been picked up. All passengers are on board. Ride started!'
            : 'You have been picked up. Waiting for other passengers...',
          waitingForOthers: !allPickedUp,
        });

        return callback?.({
          success: true,
          message: allPickedUp
            ? 'All passengers picked up. Ride started successfully!'
            : `Passenger picked up. ${remainingPassengers} passenger(s) remaining.`,
          passengerId: passenger._id,
          remainingPassengers,
          allPickedUp,
        });
      }

      // ========== কেস ৩: স্প্লিট – সব প্যাসেঞ্জার একসাথে পিকআপ ==========
      if (startType === 'all') {
        const passengers = await Passenger.find({
          rideId,
          status: PASSENGER_STATUS.matched,
        });
        if (passengers.length === 0) {
          return callback?.({
            success: false,
            message: 'No matched passengers found',
          });
        }

        // সব প্যাসেঞ্জার পিকআপ আপডেট
        for (const passenger of passengers) {
          passenger.status = PASSENGER_STATUS.picked_up;
          passenger.pickedUpAt = new Date();
          await passenger.save();

          await Booking.findOneAndUpdate(
            { passengerId: passenger._id },
            { bookingStatus: BOOKING_STATUS.running }
          );

          io.to(`user:${passenger.userId}`).emit('ride:trip-started', {
            rideId,
            passengerId: passenger._id,
            driverId,
            startTime: new Date(),
            message: 'Your trip has started. Enjoy the ride!',
            waitingForOthers: false,
          });
        }

        // রাইড আপডেট
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.in_progress,
          tripStartedAt: new Date(),
          startOdometer: startOdometer || 0,
        });

        // Redis ইভেন্ট লগ
        await redis.rpush(
          `ride:${rideId}:live`,
          JSON.stringify({
            event: 'TRIP_STARTED_ALL',
            driverId,
            passengerCount: passengers.length,
            passengerIds: passengers.map((p) => p._id),
            timestamp: Date.now(),
            startOdometer: startOdometer || 0,
          })
        );

        await redis.set(`driver:${driverId}:activeRide`, rideId);
        await redis.expire(`driver:${driverId}:activeRide`, 7200);

        io.to(`ride:${rideId}`).emit('ride:status-update', {
          rideId,
          status: 'in_progress',
          startedAt: new Date(),
          allPassengersPickedUp: true,
        });

        return callback?.({
          success: true,
          message: 'All passengers picked up. Ride started successfully!',
          passengerCount: passengers.length,
          allPickedUp: true,
        });
      }

      // যদি invalid combination আসে
      return callback?.({
        success: false,
        message: 'Invalid startType or missing passengerId for single pickup',
      });
    } catch (error) {
      console.error('Error in driverStartTripHandler:', error);
      return callback?.({ success: false, message: 'Internal server error' });
    }
  }
);
