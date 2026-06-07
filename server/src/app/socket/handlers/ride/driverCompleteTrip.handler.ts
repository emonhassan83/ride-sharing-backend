// handlers/driver/driverCompleteTrip.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import {
  BOOKING_STATUS,
  PAYMENT_STATUS,
} from '../../../modules/booking/booking.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import {
  calculateTotalDistance,
  calculateDuration,
  calculateFareFromDistance,
} from '../../../utils/location.utils';
import { saveLocationsToDatabase } from '../../../utils/location.db.utils';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';

/**
 * driver:complete-trip Handler
 *
 * কেস ১: স্প্লিট রাইড – নির্দিষ্ট প্যাসেঞ্জার ড্রপ (passengerId + completeType='single')
 * কেস ২: স্প্লিট রাইড – সব প্যাসেঞ্জার একসাথে ড্রপ (completeType='all')
 * কেস ৩: প্রাইভেট রাইড – সম্পূর্ণ রাইড ড্রপ (completeType যেকোনো কিছু হতে পারে)
 */
export const driverCompleteTripHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const {
      rideId,
      passengerId,
      endOdometer,
      completeType = 'all',
      waitingCharge = 0,
      extraCharge = 0,
    } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const redis = getRedisClient();
    const io = getIO();

    const ride = await Ride.findById(rideId);
    if (!ride) return callback?.({ success: false, message: 'Ride not found' });
    if (ride.driverId?.toString() !== driverId)
      return callback?.({
        success: false,
        message: 'You are not assigned to this ride',
      });
    if (ride.status !== RIDE_STATUS.started)
      return callback?.({
        success: false,
        message: `Ride cannot be completed in current state: ${ride.status}`,
      });

    // ── Driver info ───────────────────────────────────────────────────────────
    const driverDetails = await redis.hgetall(`driver:${driverId}:details`);
    const driverName = driverDetails?.name || socket.auth?.name || 'Unknown';
    const driverPhone = driverDetails?.phone || socket.auth?.phone || '';
    const driverPhoto = driverDetails?.photo || socket.auth?.photo || '';
    const carModel =
      driverDetails?.vehicleModel || socket.auth?.vehicle?.model || 'Standard';
    const carNumber =
      driverDetails?.vehicleNumber || socket.auth?.vehicle?.number || 'Unknown';

    // ── Location history from Redis ───────────────────────────────────────────
    const locationKey = `ride:${rideId}:live`;
    const locations = await redis.lrange(locationKey, 0, -1);
    const parsedLocations = locations.map((loc: string) => JSON.parse(loc));

    // ── Get real distance & duration per passenger via Google Maps ────────────
    const getPassengerDistanceDuration = async (
      passenger: any
    ): Promise<{
      distanceKm: number;
      durationSeconds: number;
      fare: number;
    }> => {
      const pickupLat = passenger.pickup.coordinates[1];
      const pickupLng = passenger.pickup.coordinates[0];
      const destLat = passenger.destination.coordinates[1];
      const destLng = passenger.destination.coordinates[0];

      try {
        const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
          { lat: pickupLat, lng: pickupLng },
          { lat: destLat, lng: destLng }
        );

        const fare = calculateFareFromDistance(distanceKm);
        return {
          distanceKm,
          durationSeconds: durationMinutes * 60,
          fare,
        };
      } catch {
        // Fallback to Redis location data
        const distanceKm =
          calculateTotalDistance(parsedLocations) ||
          passenger.estimatedDistanceKm ||
          0;
        const durationSeconds = calculateDuration(parsedLocations) || 0;
        const fare = calculateFareFromDistance(distanceKm);
        return { distanceKm, durationSeconds, fare };
      }
    };

    // ── Helper: complete a single passenger ───────────────────────────────────
    const completePassenger = async (passenger: any) => {
      const {
        distanceKm,
        durationSeconds,
        fare: calculatedFare,
      } = await getPassengerDistanceDuration(passenger);

      const baseFare = passenger.estimatedFare || calculatedFare;
      const totalFare = baseFare + waitingCharge + extraCharge;

      passenger.status = PASSENGER_STATUS.dropped_off;
      passenger.droppedOffAt = new Date();
      if (waitingCharge) passenger.waitingCharge = waitingCharge;
      if (extraCharge) passenger.extraCharge = extraCharge;
      await passenger.save();

      await Booking.findOneAndUpdate(
        { passengerId: passenger._id },
        {
          totalFare,
          amountPaid: totalFare,
          bookingStatus: BOOKING_STATUS.completed,
          paymentStatus: PAYMENT_STATUS.paid,
        }
      );

      io.to(`user:${passenger.userId}`).emit('ride:trip-completed', {
        rideId,
        passengerId: passenger._id,
        fare: totalFare,
        distance: distanceKm,
        duration: durationSeconds,
        message: 'Trip completed successfully. Thank you for riding with us!',
        waitingCharge,
        extraCharge,
      });

      io.to(`user:${passenger.userId}`).emit('ride:request-rating', {
        rideId,
        driverId,
      });

      return { totalFare, distanceKm, durationSeconds };
    };

    // ── Helper: finalize ride ─────────────────────────────────────────────────
    const finalizeRide = async (
      distanceKm: number,
      durationSeconds: number,
      totalFare?: number
    ) => {
      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.completed,
        completedAt: new Date(),
        endOdometer: endOdometer || 0,
        actualDistance: distanceKm,
        actualFare: totalFare,
        tripDuration: durationSeconds,
      });

      await saveLocationsToDatabase(rideId, parsedLocations, driverId);

      await Promise.all([
        redis.del(locationKey),
        redis.del(`ride:active:${rideId}`),
        redis.del(`driver:${driverId}:activeRide`),
      ]);

      io.to(`driver:${driverId}`).emit('ride:all-passengers-dropped', {
        rideId,
        message: 'All passengers dropped off. Ride completed.',
      });

      io.to(`ride:${rideId}`).emit('ride:status-update', {
        rideId,
        status: RIDE_STATUS.completed,
        completedAt: new Date(),
      });
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId,
        status: PASSENGER_STATUS.picked_up,
      });
      if (!passenger)
        return callback?.({
          success: false,
          message: 'No passenger found for this private ride',
        });

      const { totalFare, distanceKm, durationSeconds } =
        await completePassenger(passenger);

      await finalizeRide(distanceKm, durationSeconds, totalFare);

      return callback?.({
        success: true,
        message: 'Private ride completed successfully',
        data: {
          fare: totalFare,
          distance: distanceKm,
          duration: durationSeconds,
          passengerCount: 1,
          allDroppedOff: true
        },
      });
    }

    // ── SPLIT RIDE — single passenger drop ────────────────────────────────────
    if (completeType === 'single' && passengerId) {
      const passenger = await Passenger.findOne({
        _id: passengerId,
        rideId,
        status: PASSENGER_STATUS.picked_up,
      });
      if (!passenger)
        return callback?.({
          success: false,
          message: 'Passenger not found or already dropped off',
        });

      const { totalFare, distanceKm, durationSeconds } =
        await completePassenger(passenger);

      await redis.rpush(
        `ride:${rideId}:live`,
        JSON.stringify({
          event: 'WAYPOINT',
          note: 'PASSENGER_DROPPED_OFF',
          driverId,
          passengerId: passenger._id,
          timestamp: Date.now(),
          endOdometer: endOdometer || 0,
        })
      );

      if (endOdometer && !ride.endOdometer)
        await Ride.findByIdAndUpdate(rideId, { endOdometer });

      const remainingPassengers = await Passenger.countDocuments({
        rideId,
        status: PASSENGER_STATUS.picked_up,
      });
      const allDroppedOff = remainingPassengers === 0;

      if (allDroppedOff)
        await finalizeRide(distanceKm, durationSeconds, totalFare);

      return callback?.({
        success: true,
        message: allDroppedOff
          ? 'All passengers dropped off. Ride completed!'
          : `Passenger dropped off. ${remainingPassengers} passenger(s) remaining.`,
        data: {
          passengerId: passenger._id,
          fare: totalFare,
          distance: distanceKm,
          duration: durationSeconds,
          remainingPassengers,
          allDroppedOff,
        },
      });
    }

    // ── SPLIT RIDE — all passengers drop ─────────────────────────────────────
    if (completeType === 'all') {
      const passengers = await Passenger.find({
        rideId,
        status: PASSENGER_STATUS.picked_up,
      });
      if (!passengers.length)
        return callback?.({
          success: false,
          message: 'No passengers found for this ride',
        });

      let totalFareSum = 0;
      let lastDistanceKm = 0;
      let lastDurationSec = 0;

      for (const passenger of passengers) {
        const { totalFare, distanceKm, durationSeconds } =
          await completePassenger(passenger);
        totalFareSum += totalFare;
        lastDistanceKm = distanceKm;
        lastDurationSec = durationSeconds;
      }

      await finalizeRide(lastDistanceKm, lastDurationSec, totalFareSum);

      return callback?.({
        success: true,
        message: 'All passengers dropped off. Ride completed successfully!',
        data: {
          totalFare: totalFareSum,
          passengerCount: passengers.length,
          allDroppedOff: true,
        },
      });
    }

    return callback?.({
      success: false,
      message: 'Invalid completeType or missing passengerId for single dropoff',
    });
  }
);
