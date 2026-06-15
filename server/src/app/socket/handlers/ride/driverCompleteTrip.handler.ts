// handlers/driver/driverCompleteTrip.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { saveLocationsToDatabase } from '../../../utils/location.db.utils';
import { TSocket } from '../../interface/index.interface';
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
      return callback?.({ success: false, message: `Cannot complete — status: ${ride.status}` });

    const locationKey     = `ride:${rideId}:live`;
    const locations       = await redis.lrange(locationKey, 0, -1);
    const parsedLocations = locations.map((loc: string) => JSON.parse(loc));

    // ── Helper: complete single passenger ─────────────────────────────────────
    const completePassenger = async (passenger: any) => {
      // ✅ Waiting charge must be paid before completing
      if (passenger.waitingStartedAt && !passenger.waitingChargePaid) {
        return {
          success:  false,
          message: `Waiting charge not yet paid for passenger ${passenger._id}. Pick up the passenger first.`,
        };
      }

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
        fare:          passenger.estimatedFare || 0,
        waitingCharge: passenger.waitingCharge || 0,
        totalFare,
        distance:      passenger.estimatedDistanceKm      || 0,
        duration:      passenger.estimatedDurationMinutes || 0,
        message:       'Trip completed successfully. Thank you!',
      });

      io.to(`user:${passenger.userId}`).emit('ride:request-rating', { rideId, driverId });

      return { success: true, totalFare };
    };

    // ── Helper: finalize ride ─────────────────────────────────────────────────
    const finalizeRide = async (totalFare: number) => {
      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.completed, completedAt: new Date(),
      });

      await saveLocationsToDatabase(rideId, parsedLocations, driverId);

      await Promise.all([
        redis.del(locationKey),
        redis.del(`ride:active:${rideId}`),
        redis.del(`driver:${driverId}:activeRide`),
      ]);

      io.to(`driver:${driverId}`).emit('ride:all-passengers-dropped', {
        rideId, totalFare, message: 'Ride completed successfully.',
      });
      io.to(`ride:${rideId}`).emit('ride:status-update', {
        rideId, status: RIDE_STATUS.completed, completedAt: new Date(),
      });
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId, status: PASSENGER_STATUS.dropped_off,
      });
      if (!passenger)
        return callback?.({ success: false, message: 'No dropped off passenger. Drop off first.' });

      const result = await completePassenger(passenger);
      if (!result.success)
        return callback?.({ success: false, message: result.message });

      await finalizeRide(result.totalFare!);

      return callback?.({
        success: true,
        message: 'Ride completed successfully',
        data:    { totalFare: result.totalFare, passengerCount: 1, completedAt: new Date() },
      });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required' });

      const passenger = await Passenger.findOne({
        _id: passengerId, rideId, status: PASSENGER_STATUS.dropped_off,
      });
      if (!passenger)
        return callback?.({ success: false, message: 'Passenger not dropped off yet' });

      const result = await completePassenger(passenger);
      if (!result.success)
        return callback?.({ success: false, message: result.message });

      const remainingCount = await Passenger.countDocuments({
        rideId,
        status: { $in: [PASSENGER_STATUS.in_progress, PASSENGER_STATUS.picked_up, PASSENGER_STATUS.dropped_off] },
        _id:    { $ne: passenger._id },
      });

      if (remainingCount === 0) {
        const all        = await Passenger.find({ rideId, status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] } });
        const grandTotal = all.reduce((sum, p) => sum + (p.estimatedFare || 0) + (p.waitingCharge || 0), 0);
        await finalizeRide(grandTotal);
      }

      return callback?.({
        success: true,
        message: remainingCount === 0 ? 'All passengers completed. Ride finished.' : `Passenger completed. ${remainingCount} remaining.`,
        data:    { passengerId: passenger._id, fare: result.totalFare, remainingPassengers: remainingCount, rideCompleted: remainingCount === 0, completedAt: new Date() },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  },
);