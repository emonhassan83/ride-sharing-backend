// handlers/ride/rideRequest.handler.ts
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
import { getRealDistanceAndETA, getRouteGeometry } from '../../../utils/maps.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { notifyNearbyDrivers } from '../../../utils/notifyDrivers.utils';

export const rideRequestHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const {
      pickup, destination, type, seats,
      malePassengers, femalePassengers,
      scheduledDate, scheduledTime,
      luggageCounts, note,
    } = data;
    const userId = socket.auth?._id?.toString();

    if (!userId || !pickup || !destination || !type)
      return callback?.({ success: false, message: 'Missing required fields' });

    if (!scheduledDate || !scheduledTime)
      return callback?.({ success: false, message: 'scheduledDate and scheduledTime are required' });

    const requestedSeats = seats || 1;

    // ── Departure datetime ────────────────────────────────────────────────────
    const [year, month, day] = scheduledDate.split('-').map(Number);
    const [hour, minute]     = scheduledTime.split(':').map(Number);
    const departureDateTime  = new Date(year, month - 1, day, hour, minute);

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
    }

    // ── Route geometry ────────────────────────────────────────────────────────
    let routeGeometry = {};
    try { routeGeometry = await getRouteGeometry(pickup, destination); } catch { /* ignore */ }

    // ── Fare breakdown ────────────────────────────────────────────────────────
    const fareBreakdown = await calculateFareBreakdown({
      distanceKm:     actualDistance,
      departureDate:  departureDateTime,
      departureTime:  scheduledTime,
      luggageCount:   luggageCounts || 0,
      requestedSeats,
      rideType:       type,
      waitingMinutes: 0,
    });
    const roundedBreakdown = roundObjectNumbers(fareBreakdown);
    const fareType         = getFareType(departureDateTime);

    // ── Create Ride ───────────────────────────────────────────────────────────
    const ride = await Ride.create({
      type,
      rideCreatedBy: userId,
      pickup:        { address: pickup.address,      coordinates: [pickup.lng, pickup.lat] },
      destination:   { address: destination.address, coordinates: [destination.lng, destination.lat] },
      departureDate: scheduledDate,
      departureTime: scheduledTime,
      totalSeats:    requestedSeats,
      bookedSeats:   0,
      status:        RIDE_STATUS.pending,
      routeGeometry,
    });

    // ── Create Passenger ──────────────────────────────────────────────────────
    const passenger = await Passenger.create({
      userId,
      rideId:                   ride._id,
      pickup:                   { address: pickup.address,      coordinates: [pickup.lng, pickup.lat] },
      destination:              { address: destination.address, coordinates: [destination.lng, destination.lat] },
      departureDate:            scheduledDate,
      departureTime:            scheduledTime,
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
      waitingCharge:            fareBreakdown.waitingCharge || 0,
      estimatedDistanceKm:      actualDistance,
      estimatedDurationMinutes: actualDuration,
      luggageCounts:            luggageCounts || 0,
      note:                     note ?? '',
      status:                   PASSENGER_STATUS.pending,
    });

    const redis = getRedisClient();
    const io    = getIO();

    socket.join(`ride:${ride._id}`);
    socket.join(`passenger:${passenger._id}`);

    // ── Rider info for driver notification ────────────────────────────────────
    const rider = await User.findById(userId)
      .select('name profileImage avgRating phone')
      .lean();

    const ridePayload = {
      rideId:        ride._id.toString(),
      passengerId:   passenger._id.toString(),
      riderInfo: {
        name:         rider?.name         || '',
        profileImage: rider?.profileImage || null,
        avgRating:    rider?.avgRating    || 0,
        phone:        rider?.phone        || '',
      },
      rideType:      type,
      pickup,
      destination,
      requestedSeats,
      luggageCount:  luggageCounts || 0,
      estimatedFare: roundedBreakdown.totalFare,
      distance:      roundTo2(actualDistance),
      departureDate: scheduledDate,
      departureTime: scheduledTime,
    };

    // ── Phase 1: Immediate notify — online + offline nearby drivers ───────────
    const notifiedCount = await notifyNearbyDrivers(
      ride._id.toString(),
      pickup,
      ridePayload,
      redis,
      io,
      passenger._id.toString()
    );

    console.log(`📡 Phase 1: Notified ${notifiedCount} driver(s) for ride ${ride._id}`);

    // ── Redis: store ride request data ────────────────────────────────────────
    await redis.hset(`ride:request:${ride._id}`, {
      userId,
      passengerId:   passenger._id.toString(),
      pickup:        JSON.stringify(pickup),
      destination:   JSON.stringify(destination),
      seats:         requestedSeats.toString(),
      estimatedFare: fareBreakdown.totalFare.toString(),
      scheduledDate,
      scheduledTime,
      departureTimestamp: departureDateTime.getTime().toString(),
      notifiedCount:      notifiedCount.toString(),
      timestamp:          Date.now().toString(),
    });
    // TTL = departure time + 2 hours buffer
    const ttlSeconds = Math.max(
      3600,
      Math.floor((departureDateTime.getTime() - Date.now()) / 1000) + 7200,
    );
    await redis.expire(`ride:request:${ride._id}`, ttlSeconds);

    return callback?.({
      success: true,
      message: `Ride request created. ${notifiedCount} nearby driver(s) notified.`,
      data: {
        rideId:            ride._id,
        passengerId:       passenger._id,
        notifiedDrivers:   notifiedCount,
        estimatedFare:     roundedBreakdown.totalFare,
        estimatedDistance: roundTo2(actualDistance),
        estimatedDuration: actualDuration,
        fareBreakdown:     roundedBreakdown,
        rideDetails: {
          bookingDate: scheduledDate,
          bookingTime: scheduledTime,
          pickup:      passenger.pickup,
          destination: passenger.destination,
          rideType:    ride.type,
          totalSeats:  ride.totalSeats,
        },
      },
    });
  },
);