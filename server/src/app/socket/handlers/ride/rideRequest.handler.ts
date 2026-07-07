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
import { fetchDriversWithinRadius } from '../../../utils/geo.utils';

export const rideRequestHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const {
      pickup, destination, type, passengers,
      malePassengers, femalePassengers,
      departureDate, departureTime,
      luggageCounts, note,
      selectedDriverId, driverId,
    } = data;
    const userId = socket.auth?._id?.toString();

    if (!userId || !pickup || !destination || !type)
      return callback?.({ success: false, message: 'Missing required fields' });

    if (!departureDate || !departureTime)
      return callback?.({ success: false, message: 'departureDate and departureTime are required' });

    const requestedSeats = Number(passengers) > 0 ? Number(passengers) : 1;

    const [year, month, day] = departureDate.split('-').map(Number);
    const [hour, minute]     = departureTime.split(':').map(Number);
    const departureDateTime  = new Date(year, month - 1, day, hour, minute);

    const redis = getRedisClient();
    const io    = getIO();

    // ✅ Check available drivers BEFORE creating ride/passenger
    const eligibleDrivers = await fetchDriversWithinRadius(
      redis,
      pickup.lng,
      pickup.lat,
      10,
      type,
      requestedSeats,
      destination,
      departureDate,
      departureTime,
    );
    const requestedDriverId = selectedDriverId || driverId;
    const driversAvailable = requestedDriverId
      ? eligibleDrivers.some(
          (driver: any) => driver.driverId === requestedDriverId.toString()
        )
      : eligibleDrivers.length > 0;

    if (!driversAvailable) {
      return callback?.({
        success: false,
        message: 'No drivers available for this date and time. Please try a different time.',
        code:    'NO_DRIVERS_AVAILABLE',
      });
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
    }

    // ── Route geometry ────────────────────────────────────────────────────────
    let routeGeometry = {};
    try { routeGeometry = await getRouteGeometry(pickup, destination); } catch { /* ignore */ }

    // ── Fare breakdown ────────────────────────────────────────────────────────
    const fareBreakdown = await calculateFareBreakdown({
      distanceKm:     actualDistance,
      departureDate:  departureDateTime,
      departureTime:  departureTime,
      luggageCount:   luggageCounts || 0,
      requestedSeats,
      rideType:       type,
      waitingMinutes: 0,
    });
    const roundedBreakdown = roundObjectNumbers(fareBreakdown);
    const fareType         = getFareType(departureDateTime);

    // ── Determine totalSeats from vehicle for split rides ────────────────────
    // let totalSeats = requestedSeats;
    // if (type === RIDE_TYPE.split) {
    //   const vehicle = await Vehicle.findOne({
    //     userId,
    //     isDefault: true,
    //     isDeleted: false,
    //   }).select('seats').lean();
    //   totalSeats = vehicle?.seats || requestedSeats;
    // }

    // ── Create Ride ───────────────────────────────────────────────────────────
    const ride = await Ride.create({
      type,
      rideCreatedBy: userId,
      pickup:        { address: pickup.address,      coordinates: [pickup.lng, pickup.lat] },
      destination:   { address: destination.address, coordinates: [destination.lng, destination.lat] },
      departureDate: departureDate,
      departureTime: departureTime,
      totalSeats:    0,
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
      departureDate:            departureDate,
      departureTime:            departureTime,
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
      totalFare:                roundTo2(fareBreakdown.totalFare),
      waitingCharge:            fareBreakdown.waitingCharge || 0,
      estimatedDistanceKm:      actualDistance,
      estimatedDurationMinutes: actualDuration,
      luggageCounts:            luggageCounts || 0,
      note:                     note ?? '',
      status:                   PASSENGER_STATUS.pending,
    });

    socket.join(`ride:${ride._id}`);
    socket.join(`passenger:${passenger._id}`);

    const rider = await User.findById(userId)
      .select('name profileImage avgRating phone')
      .lean();

    const ridePayload = {
      _id:  passenger._id,
      userId: {
        _id:          rider?._id          || null,
        name:         rider?.name         || '',
        profileImage: rider?.profileImage || null,
      },
      rideId: {
        _id:  ride._id,
        type: ride.type,
        id:   (ride as any).id || '',
      },
      pickup: {
        address:     pickup.address,
        coordinates: [pickup.lng, pickup.lat],
      },
      destination: {
        address:     destination.address,
        coordinates: [destination.lng, destination.lat],
      },
      departureDate:       departureDate,
      departureTime:       departureTime,
      rideType:            type,
      requestedSeats,
      estimatedFare:       roundTo2(fareBreakdown.totalFare),
      estimatedDistanceKm: roundTo2(actualDistance),
      status:              PASSENGER_STATUS.pending,
      createdAt:           passenger.createdAt,
    };

    // ── Notify drivers ────────────────────────────────────────────────────────
    const notifiedCount = await notifyNearbyDrivers(
      ride._id.toString(),
      pickup,
      ridePayload,
      redis,
      io,
      passenger._id.toString(),
      10,
      requestedDriverId ? [requestedDriverId.toString()] : undefined,
    );

    console.log(`📡 Phase 1: Notified ${notifiedCount} driver(s) for ride ${ride._id}`);

    // ── Rollback if no drivers were notified ──────────────────────────────────
    if (notifiedCount === 0) {
      await Ride.findByIdAndDelete(ride._id);
      await Passenger.findByIdAndDelete(passenger._id);
      return callback?.({
        success: false,
        message: 'No available drivers found for this date and time. Please try again later.',
        code: 'NO_DRIVERS_AVAILABLE',
      });
    }

    // ── Redis ─────────────────────────────────────────────────────────────────
    await redis.hset(`ride:request:${ride._id}`, {
      userId,
      passengerId:        passenger._id.toString(),
      pickup:             JSON.stringify(pickup),
      destination:        JSON.stringify(destination),
      seats:              requestedSeats.toString(),
      estimatedFare:      fareBreakdown.totalFare.toString(),
      departureDate,
      departureTime,
      departureTimestamp: departureDateTime.getTime().toString(),
      notifiedCount:      notifiedCount.toString(),
      timestamp:          Date.now().toString(),
    });

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
          bookingDate: departureDate,
          bookingTime: departureTime,
          pickup:      passenger.pickup,
          destination: passenger.destination,
          rideType:    ride.type,
          totalSeats:  ride.totalSeats,
        },
      },
    });
  },
);
