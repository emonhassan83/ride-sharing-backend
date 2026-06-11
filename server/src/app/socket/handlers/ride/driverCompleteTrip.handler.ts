// handlers/driver/driverCompleteTrip.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS, PAYMENT_STATUS } from '../../../modules/booking/booking.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { saveLocationsToDatabase } from '../../../utils/location.db.utils';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

export const driverCompleteTripHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const redis = getRedisClient();
    const io    = getIO();

    // ── Validate ride ─────────────────────────────────────────────────────────
    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });

    if (ride.driverId?.toString() !== driverId)
      return callback?.({ success: false, message: 'You are not assigned to this ride' });

    if (ride.status !== RIDE_STATUS.started)
      return callback?.({ success: false, message: `Cannot complete — ride status: ${ride.status}` });

    // ── All passengers must be dropped off first ──────────────────────────────
    const notDroppedOff = await Passenger.countDocuments({
      rideId,
      status: { $in: [PASSENGER_STATUS.in_progress, PASSENGER_STATUS.picked_up] },
    });

    if (notDroppedOff > 0)
      return callback?.({
        success: false,
        message: `${notDroppedOff} passenger(s) not yet dropped off. Drop off all passengers first.`,
      });

    // ── Get dropped off passengers ────────────────────────────────────────────
    const passengers = await Passenger.find({
      rideId,
      status: PASSENGER_STATUS.dropped_off,
    });

    if (!passengers.length)
      return callback?.({ success: false, message: 'No dropped off passengers found' });

    // ── Location history from Redis ───────────────────────────────────────────
    const locationKey     = `ride:${rideId}:live`;
    const locations       = await redis.lrange(locationKey, 0, -1);
    const parsedLocations = locations.map((loc: string) => JSON.parse(loc));

    // ── Complete each passenger ───────────────────────────────────────────────
    let totalFareSum = 0;

    for (const passenger of passengers) {
      const totalFare =
        (passenger.estimatedFare || 0) +
        (passenger.waitingCharge || 0);

      totalFareSum += totalFare;

      // ── Update booking → completed ────────────────────────────────────────
      await Booking.findOneAndUpdate(
        { passengerId: passenger._id },
        {
          totalFare,
          amountPaid:    totalFare,
          bookingStatus: BOOKING_STATUS.completed,
        },
      );

      // ── Notify passenger — trip completed ─────────────────────────────────
      io.to(`user:${passenger.userId}`).emit('ride:trip-completed', {
        rideId,
        passengerId:  passenger._id,
        fare:         totalFare,
        distance:     passenger.estimatedDistanceKm      || 0,
        duration:     passenger.estimatedDurationMinutes || 0,
        waitingCharge: passenger.waitingCharge || 0,
        message:      'Trip completed successfully. Thank you for riding with us!',
      });

      io.to(`user:${passenger.userId}`).emit('ride:request-rating', {
        rideId,
        driverId,
      });
    }

    // ── Finalize ride → completed ─────────────────────────────────────────────
    await Ride.findByIdAndUpdate(rideId, {
      status:       RIDE_STATUS.completed,
      completedAt:  new Date()
    });

    // ── Save location history & Redis cleanup ─────────────────────────────────
    await saveLocationsToDatabase(rideId, parsedLocations, driverId);

    await Promise.all([
      redis.del(locationKey),
      redis.del(`ride:active:${rideId}`),
      redis.del(`driver:${driverId}:activeRide`),
    ]);

    // ── Notify driver ─────────────────────────────────────────────────────────
    io.to(`driver:${driverId}`).emit('ride:all-passengers-dropped', {
      rideId,
      totalFare:    totalFareSum,
      message:      'Ride completed successfully.',
    });

    console.log(`✅ Ride ${rideId} completed | passengers: ${passengers.length} | totalFare: ${totalFareSum}`);

    return callback?.({
      success:        true,
      message:        'Ride completed successfully',
      data: {
        totalFare:      totalFareSum,
        passengerCount: passengers.length,
        completedAt:    new Date(),
      },
    });
  },
);