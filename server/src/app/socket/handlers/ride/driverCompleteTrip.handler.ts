// handlers/driver/driverCompleteTrip.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { saveLocationsToDatabase } from '../../../utils/location.db.utils';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

export const driverCompleteTripHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const redis = getRedisClient();
    const io    = getIO();

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });

    if (ride.driverId?.toString() !== driverId)
      return callback?.({ success: false, message: 'You are not assigned to this ride' });

    if (ride.status !== RIDE_STATUS.started)
      return callback?.({ success: false, message: `Cannot complete — ride status: ${ride.status}` });

    const locationKey     = `ride:${rideId}:live`;
    const locations       = await redis.lrange(locationKey, 0, -1);
    const parsedLocations = locations.map((loc: string) => JSON.parse(loc));

    // ── Helper: complete single passenger ─────────────────────────────────────
    const completePassenger = async (passenger: any) => {
      const totalFare = (passenger.estimatedFare || 0) + (passenger.waitingCharge || 0);

      await Booking.findOneAndUpdate(
        { passengerId: passenger._id },
        {
          totalFare,
          amountPaid:    totalFare,
          bookingStatus: BOOKING_STATUS.completed,
        },
      );

      io.to(`user:${passenger.userId}`).emit('ride:trip-completed', {
        rideId,
        passengerId:   passenger._id,
        fare:          totalFare,
        distance:      passenger.estimatedDistanceKm      || 0,
        duration:      passenger.estimatedDurationMinutes || 0,
        waitingCharge: passenger.waitingCharge            || 0,
        message:       'Trip completed successfully. Thank you for riding with us!',
      });

      io.to(`user:${passenger.userId}`).emit('ride:request-rating', { rideId, driverId });

      return totalFare;
    };

    // ── Helper: finalize ride ─────────────────────────────────────────────────
    const finalizeRide = async (totalFare: number) => {
      await Ride.findByIdAndUpdate(rideId, {
        status:      RIDE_STATUS.completed,
        completedAt: new Date(),
      });

      await saveLocationsToDatabase(rideId, parsedLocations, driverId);

      await Promise.all([
        redis.del(locationKey),
        redis.del(`ride:active:${rideId}`),
        redis.del(`driver:${driverId}:activeRide`),
      ]);

      io.to(`driver:${driverId}`).emit('ride:all-passengers-dropped', {
        rideId,
        totalFare,
        message: 'Ride completed successfully.',
      });

      io.to(`ride:${rideId}`).emit('ride:status-update', {
        rideId,
        status:      RIDE_STATUS.completed,
        completedAt: new Date(),
      });
    };

    // ── PRIVATE RIDE — complete entire ride ───────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId,
        status: PASSENGER_STATUS.dropped_off,
      });

      if (!passenger)
        return callback?.({ success: false, message: 'No dropped off passenger found. Drop off first.' });

      const totalFare = await completePassenger(passenger);
      await finalizeRide(totalFare);

      console.log(`✅ Private ride completed | rideId: ${rideId}`);

      return callback?.({
        success: true,
        message: 'Ride completed successfully',
        data:    { totalFare, passengerCount: 1, completedAt: new Date() },
      });
    }

    // ── SPLIT RIDE — complete specific passenger ──────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required for split ride' });

      const passenger = await Passenger.findOne({
        _id:    passengerId,
        rideId,
        status: PASSENGER_STATUS.dropped_off,
      });

      if (!passenger)
        return callback?.({ success: false, message: 'Passenger not found or not dropped off yet' });

      const totalFare = await completePassenger(passenger);

      // Check remaining not-yet-completed passengers
      const remainingCount = await Passenger.countDocuments({
        rideId,
        status: { $in: [PASSENGER_STATUS.in_progress, PASSENGER_STATUS.picked_up, PASSENGER_STATUS.dropped_off] },
        _id:    { $ne: passenger._id },
      });

      const allCompleted = remainingCount === 0;

      if (allCompleted) {
        // Get total fare of all completed passengers
        const allPassengers = await Passenger.find({ rideId });
        const grandTotal    = allPassengers.reduce(
          (sum, p) => sum + (p.estimatedFare || 0) + (p.waitingCharge || 0), 0,
        );
        await finalizeRide(grandTotal);
        console.log(`✅ Split ride fully completed | rideId: ${rideId}`);
      }

      console.log(`✅ Split passenger completed | passengerId: ${passengerId} | remaining: ${remainingCount}`);

      return callback?.({
        success: true,
        message: allCompleted
          ? 'All passengers completed. Ride finished.'
          : `Passenger completed. ${remainingCount} passenger(s) remaining.`,
        data: {
          passengerId:         passenger._id,
          fare:                totalFare,
          remainingPassengers: remainingCount,
          rideCompleted:       allCompleted,
          completedAt:         new Date(),
        },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  },
);