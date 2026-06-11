// handlers/ride/splitRideRequest.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { RIDE_STATUS } from '../../../modules/ride/ride.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { User } from '../../../modules/user/user.model';
import { calculateDistance } from '../../../utils/location.utils';
import { calculateFareBreakdown } from '../../../utils/fareCalculator';
import { getFareType } from '../../../utils/time.utils';
import { roundObjectNumbers, roundTo2 } from '../../../utils/number.utils';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

export const joinSplitRideRequestHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const {
      rideId,
      pickup,
      destination,
      seats,
      malePassengers,
      femalePassengers,
      scheduledDate,
      scheduledTime,
      luggageCounts,
      note,
    } = data;
    const userId = socket.auth?._id?.toString();

    if (!userId)
      return callback?.({ success: false, message: 'Unauthorized' });

    if (!rideId)
      return callback?.({ success: false, message: 'rideId is required' });

    if (!pickup || !destination)
      return callback?.({ success: false, message: 'Pickup and destination are required' });

    const requestedSeats = seats || 1;

    // ── Find and validate the existing ride ───────────────────────────────────
    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });

    if (ride.type !== 'split')
      return callback?.({ success: false, message: 'This ride is not a split ride' });

    if (ride.status !== RIDE_STATUS.pending && ride.status !== RIDE_STATUS.accepted)
      return callback?.({
        success: false,
        message: `Cannot join ride — current status: ${ride.status}`,
      });

    // ── Seat availability check ───────────────────────────────────────────────
    const availableSeats = ride.totalSeats - (ride.bookedSeats || 0);
    if (availableSeats < requestedSeats)
      return callback?.({
        success: false,
        message: `Not enough seats. Only ${availableSeats} seat(s) available, but ${requestedSeats} requested.`,
      });

    // ── Prevent duplicate join ────────────────────────────────────────────────
    const alreadyJoined = await Passenger.findOne({
      rideId,
      userId,
      status: { $nin: [PASSENGER_STATUS.cancelled] },
    });
    if (alreadyJoined)
      return callback?.({ success: false, message: 'You have already joined this ride' });

    // ── Departure datetime ────────────────────────────────────────────────────
    let departureDateTime = new Date();
    if (scheduledDate && scheduledTime) {
      const [year, month, day] = scheduledDate.split('-').map(Number);
      const [hour, minute]     = scheduledTime.split(':').map(Number);
      departureDateTime = new Date(year, month - 1, day, hour, minute);
    } else {
      // fallback to ride's own departure
      departureDateTime = new Date(`${ride.departureDate}T${ride.departureTime}:00`);
    }

    // ── Real distance & ETA ───────────────────────────────────────────────────
    let actualDistance = 0;
    let actualDuration = 0;
    try {
      const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
        { lat: pickup.lat,      lng: pickup.lng      },
        { lat: destination.lat, lng: destination.lng },
      );
      actualDistance = distanceKm;
      actualDuration = durationMinutes;
    } catch {
      actualDistance = calculateDistance(
        { lat: pickup.lat,      lng: pickup.lng      },
        { lat: destination.lat, lng: destination.lng },
      );
      actualDuration = Math.ceil((actualDistance / 30) * 60);
      console.warn('⚠️ Google Maps failed — using Haversine fallback');
    }

    // ── Fare breakdown ────────────────────────────────────────────────────────
    const fareBreakdown = await calculateFareBreakdown({
      distanceKm:     actualDistance,
      departureDate:  departureDateTime,
      departureTime:  scheduledTime || ride.departureTime,
      luggageCount:   luggageCounts || 0,
      requestedSeats,
      rideType:       'split',
      waitingMinutes: 0,
    });

    const roundedBreakdown = roundObjectNumbers(fareBreakdown);
    const fareType         = getFareType(departureDateTime);

    // ── Create Passenger ──────────────────────────────────────────────────────
    const passenger = await Passenger.create({
      userId,
      rideId:                   ride._id,
      pickup: {
        address:     pickup.address,
        coordinates: [pickup.lng, pickup.lat],
      },
      destination: {
        address:     destination.address,
        coordinates: [destination.lng, destination.lat],
      },
      departureDate:            scheduledDate    || ride.departureDate,
      departureTime:            scheduledTime    || ride.departureTime,
      requestedSeats,
      malePassengers:           malePassengers   || 0,
      femalePassengers:         femalePassengers || 0,
      fareType,
      initialCharge:            fareBreakdown.initialCharge,
      perKmCharge:              fareBreakdown.perKmCharge,
      totalKmCharge:            roundTo2(fareBreakdown.totalKmCharge),
      luggageCharge:            fareBreakdown.luggageCharge,
      holidayTripCharge:        fareBreakdown.holidaySurcharge,
      vat:                      fareBreakdown.vat,
      estimatedFare:            roundTo2(fareBreakdown.totalFare),
      waitingCharge:            fareBreakdown.waitingCharge  || 0,
      estimatedDistanceKm:      actualDistance,
      estimatedDurationMinutes: actualDuration,
      luggageCounts:            luggageCounts  || 0,
      note:                     note           ?? '',
      status:                   PASSENGER_STATUS.pending,
    });

    const redis = getRedisClient();
    const io    = getIO();

    // ── Notify driver ─────────────────────────────────────────────────────────
    const driverId = ride.driverId?.toString();
    if (driverId) {
      const rider = await User.findById(userId)
        .select('name profileImage avgRating phone')
        .lean();

      io.to(`driver:${driverId}`).emit('ride:new-request', {
        rideId:      ride._id.toString(),
        passengerId: passenger._id.toString(),
        riderInfo: {
          name:         rider?.name         || '',
          profileImage: rider?.profileImage || null,
          avgRating:    rider?.avgRating    || 0,
          phone:        rider?.phone        || '',
        },
        rideType:      'split',
        pickup,
        destination,
        requestedSeats,
        luggageCount:  luggageCounts || 0,
        estimatedFare: roundedBreakdown.totalFare,
        distance:      roundTo2(actualDistance),
        expiresIn:     30,
      });

      console.log(`📡 split ride:new-request → driver:${driverId}`);

      // ── Timeout: cancel if driver doesn't respond ─────────────────────────
      setTimeout(async () => {
        const p = await Passenger.findById(passenger._id).select('status').lean();
        if (p?.status === PASSENGER_STATUS.pending) {
          await Passenger.findByIdAndUpdate(passenger._id, {
            status:             PASSENGER_STATUS.cancelled,
            cancellationReason: 'driver_timeout',
          });
          io.to(`user:${userId}`).emit('ride:driver-not-responded', {
            rideId:  ride._id,
            message: 'Driver did not respond. Please try another ride.',
          });
          console.log(`⏰ Passenger ${passenger._id} cancelled — driver timeout`);
        }
      }, 30 * 60000);
    }

    // ── Redis ─────────────────────────────────────────────────────────────────
    await redis.hset(`ride:request:${ride._id}:${passenger._id}`, {
      userId,
      passengerId:   passenger._id.toString(),
      pickup:        JSON.stringify(pickup),
      destination:   JSON.stringify(destination),
      seats:         requestedSeats.toString(),
      estimatedFare: fareBreakdown.totalFare.toString(),
      timestamp:     Date.now(),
    });
    await redis.expire(`ride:request:${ride._id}:${passenger._id}`, 1800);

    socket.join(`ride:${ride._id}`);
    socket.join(`passenger:${passenger._id}`);

    return callback?.({
      success: true,
      message: 'Split ride join request sent successfully.',
      data: {
        rideId:            ride._id,
        passengerId:       passenger._id,
        estimatedFare:     roundedBreakdown.totalFare,
        estimatedDistance: roundTo2(actualDistance),
        estimatedDuration: actualDuration,
        fareBreakdown:     roundedBreakdown,
        rideDetails: {
          bookingDate:  passenger.departureDate,
          bookingTime:  passenger.departureTime,
          pickup:       passenger.pickup,
          destination:  passenger.destination,
          rideType:     'split',
          totalSeats:   ride.totalSeats,
          bookedSeats:  ride.bookedSeats,
          availableSeats: availableSeats - requestedSeats,
        },
      },
    });
  },
);