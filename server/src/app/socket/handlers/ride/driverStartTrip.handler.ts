// handlers/driver/driverStartTrip.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

/* 
দায়িত্ব: Ride + Passenger status update করে সব rider কে notify করা
Client payload: { rideId, startOdometer? }
*/
export const driverStartTripHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, startOdometer } = data;
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
        return callback?.({ success: false, message: 'You are not assigned to this ride' });
      }
 
      const allowedStates = [RIDE_STATUS.accepted];
      if (!allowedStates.includes(ride.status as any)) {
        return callback?.({ success: false, message: 'Ride cannot be started in current state' });
      }
 
      // ─── Update Ride status → started ────────────────────────
      await Ride.findByIdAndUpdate(rideId, {
        status:        RIDE_STATUS.started,
        tripStartedAt: new Date(),
        ...(startOdometer && { startOdometer }),
      });
 
      // ─── Update ALL matched/arrived passengers → in_progress ─────
      const passengers = await Passenger.find({
        rideId,
        status: { $in: [PASSENGER_STATUS.confirmed] },
      });
      if (!passengers.length) {
        return callback?.({ success: false, message: 'No matched passengers found' });
      }
 
      for (const passenger of passengers) {
        passenger.status = PASSENGER_STATUS.in_progress;
        await passenger.save();
 
        await Booking.findOneAndUpdate(
          { passengerId: passenger._id },
          { bookingStatus: BOOKING_STATUS.running },
        );
      }
 
      // ─── Redis logs ───────────────────────────────────────────────
      const redis = getRedisClient();
      await redis.rpush(
        `ride:${rideId}:live`,
        JSON.stringify({
          event:         'TRIP_STARTED',
          driverId,
          passengerCount: passengers.length,
          passengerIds:   passengers.map(p => p._id),
          timestamp:      Date.now(),
          startOdometer:  startOdometer || 0,
        }),
      );
      await redis.set(`driver:${driverId}:activeRide`, rideId);
      await redis.expire(`driver:${driverId}:activeRide`, 7200);
 
      // ─── Notify all passengers ────────────────────────────────────
      const io = getIO();
 
      for (const passenger of passengers) {
        io.to(`ride:${rideId}`).emit('ride:trip-started', {
          rideId,
          passengerId: passenger._id,
          driverId,
          startTime:   new Date(),
          message:     'Your ride has started. Enjoy the trip!',
        });
      }
 
      // ─── Broadcast ride status update to room ─────────────────────
      io.to(`ride:${rideId}`).emit('ride:status-update', {
        rideId,
        status:    RIDE_STATUS.started,
        startedAt: new Date(),
      });
 
      console.log(`✅ Trip started | rideId: ${rideId} | passengers: ${passengers.length}`);
 
      return callback?.({
        success:        true,
        message:        'Trip started successfully',
        data: {passengerCount: passengers.length,}
      });
 
    } catch (error) {
      console.error('❌ Error in driverStartTripHandler:', error);
      return callback?.({ success: false, message: 'Internal server error' });
    }
  },
);