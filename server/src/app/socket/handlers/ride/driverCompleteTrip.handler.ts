// handlers/driver/driverCompleteTrip.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { saveLocationsToDatabase } from '../../../utils/location.db.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { sendNotification } from '../../../utils/sentPushNotification';
import { modeType } from '../../../modules/notification/notification.interface';
import { User } from '../../../modules/user/user.model';

export const driverCompleteTripHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId } = data;
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
      return callback?.({ success: false, message: `Cannot complete — status: ${ride.status}` });

    const locationKey = `ride:${rideId}:live`;
    const locations = await redis.lrange(locationKey, 0, -1);
    const parsedLocations = locations.map((loc: string) => JSON.parse(loc));

    // Complete all remaining passengers
    const passengers = await Passenger.find({
      rideId,
      status: PASSENGER_STATUS.dropped_off,
    });

    let grandTotal = 0;

    for (const passenger of passengers) {
      const totalFare = (passenger.estimatedFare || 0) + (passenger.waitingCharge || 0);
      grandTotal += totalFare;

      await Booking.findOneAndUpdate(
        { passengerId: passenger._id },
        {
          totalFare,
          amountPaid: totalFare,
          bookingStatus: BOOKING_STATUS.completed,
        }
      );

      // Notification to Passenger
      const riderUser = await User.findById(passenger.userId).select('fcmToken').lean();
      if (riderUser?.fcmToken) {
        await sendNotification([riderUser.fcmToken], {
          receiver: passenger.userId,
          message: '🏁 Trip Completed!',
          description: `Total fare: £${totalFare}. Thank you for riding with us!`,
          reference: rideId,
          modelType: modeType.Ride
        }).catch(() => {});
      }

      io.to(`user:${passenger.userId}`).emit('ride:trip-completed', {
        rideId,
        totalFare,
        message: 'Trip completed successfully. Thank you!',
      });

      io.to(`user:${passenger.userId}`).emit('ride:request-rating', { rideId, driverId });
    }

    // Finalize Ride
    await Ride.findByIdAndUpdate(rideId, {
      status: RIDE_STATUS.completed,
      completedAt: new Date(),
    });

    await saveLocationsToDatabase(rideId, parsedLocations, driverId);

    await Promise.all([
      redis.del(locationKey),
      redis.del(`ride:active:${rideId}`),
      redis.del(`driver:${driverId}:activeRide`),
    ]);

    // Notify Driver
    io.to(`driver:${driverId}`).emit('ride:trip-completed', {
      rideId,
      totalFare: grandTotal,
      message: 'Ride completed successfully!',
    });

    return callback?.({
      success: true,
      message: 'Ride completed successfully',
      data: { rideId, totalFare: grandTotal, passengerCount: passengers.length },
    });
  }
);