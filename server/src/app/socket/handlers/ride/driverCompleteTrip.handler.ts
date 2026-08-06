// handlers/driver/driverCompleteTrip.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { User } from '../../../modules/user/user.model';
import { saveLocationsToDatabase } from '../../../utils/location.db.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { sendNotification } from '../../../utils/sentPushNotification';
import { modeType } from '../../../modules/notification/notification.interface';

export const driverCompleteTripHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const redis = getRedisClient();
    const io = getIO();

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });
    if (ride.driverId?.toString() !== driverId)
      return callback?.({ success: false, message: 'You are not assigned to this ride' });
    if (ride.status !== RIDE_STATUS.started)
      return callback?.({ success: false, message: `Cannot complete ‚\u20ACî status: ${ride.status}` });

    const locationKey = `ride:${rideId}:live`;
    const locations = await redis.lrange(locationKey, 0, -1);
    const parsedLocations = locations.map((loc: string) => JSON.parse(loc));

    // ‚î\u20AC‚î\u20AC Determine which passengers to complete ‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC
    let passengers: any[];

    if (ride.type === RIDE_TYPE.private) {
      // ‚úÖ passengerId optional for private
      passengers = passengerId
        ? await Passenger.find({ _id: passengerId, rideId, status: PASSENGER_STATUS.dropped_off })
        : await Passenger.find({ rideId, status: PASSENGER_STATUS.dropped_off });
    } else {
      // ‚úÖ Split: passengerId optional ‚\u20ACî complete all dropped_off if not specified
      passengers = passengerId
        ? await Passenger.find({ _id: passengerId, rideId, status: PASSENGER_STATUS.dropped_off })
        : await Passenger.find({ rideId, status: PASSENGER_STATUS.dropped_off });
    }

    if (!passengers.length)
      return callback?.({ success: false, message: 'No dropped off passengers to complete' });

    let grandTotal = 0;

    for (const passenger of passengers) {
      const totalFare = passenger.totalFare || (passenger.estimatedFare || 0) + (passenger.waitingCharge || 0);
      grandTotal += totalFare;

      await Passenger.findByIdAndUpdate(passenger._id, { status: PASSENGER_STATUS.completed });

      await Booking.findOneAndUpdate(
        { passengerId: passenger._id },
        { totalFare, amountPaid: totalFare, bookingStatus: BOOKING_STATUS.completed },
      );

      const riderUser = await User.findById(passenger.userId).select('fcmToken').lean();
      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver: passenger.userId, message: 'Trip Completed!',
          description: `Total fare: ¬\u20AC${totalFare}. Thank you for riding with us!`,
          reference: rideId, modelType: modeType.Ride,
        }).catch(() => { });
      }

      io.to(`user:${passenger.userId}`).emit('ride:trip-completed', {
        rideId, passengerId: passenger._id, totalFare,
        message: 'Trip completed successfully. Thank you!',
      });

      io.to(`user:${passenger.userId}`).emit('ride:request-rating', { rideId, driverId });
    }

    // ‚î\u20AC‚î\u20AC Check if all passengers done (for split ride partial complete) ‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC
    const remainingDroppedOff = await Passenger.countDocuments({
      rideId,
      status: { $in: [PASSENGER_STATUS.picked_up, PASSENGER_STATUS.dropped_off] },
      ...(passengerId ? { _id: { $ne: passengerId } } : {}),
    });

    const allComplete = remainingDroppedOff === 0;

    if (allComplete) {
      await Ride.findByIdAndUpdate(rideId, { status: RIDE_STATUS.completed, completedAt: new Date() });

      try { await saveLocationsToDatabase(rideId, parsedLocations, driverId); } catch (err) {
        console.error(`‚ùå Location history save failed:`, err);
      }

      await Promise.all([
        redis.del(locationKey),
        redis.del(`ride:active:${rideId}`),
        redis.del(`driver:${driverId}:activeRide`),
      ]);

      io.to(`driver:${driverId}`).emit('ride:trip-completed', {
        rideId, totalFare: grandTotal, message: 'Ride completed successfully!',
      });
    }

    return callback?.({
      success: true,
      message: allComplete ? 'Ride completed successfully' : 'Passenger(s) completed. Ride still in progress.',
      data: { rideId, totalFare: grandTotal, passengerCount: passengers.length, allComplete },
    });
  },
);

