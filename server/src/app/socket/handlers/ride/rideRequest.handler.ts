// handlers/ride/rideRequest.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { RIDE_STATUS } from '../../../modules/ride/ride.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Vehicle } from '../../../modules/vehicle/vehicle.model';
import { calculateDistance } from '../../../utils/location.utils';
import { calculateFareBreakdown } from '../../../utils/fareCalculator';
import { getFareType } from '../../../utils/time.utils';
import { roundObjectNumbers, roundTo2 } from '../../../utils/number.utils';
import {
  getRealDistanceAndETA,
  getRouteGeometry,
} from '../../../utils/maps.utils';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { User } from '../../../modules/user/user.model';

export const rideRequestHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const {
      driverId,
      pickup,
      destination,
      type,
      seats,
      malePassengers,
      femalePassengers,
      scheduledDate,
      scheduledTime,
      luggageCounts,
      note,
    } = data;
    const userId = socket.auth?._id?.toString();

    if (!userId || !pickup || !destination)
      return callback?.({ success: false, message: 'Missing required fields' });

    if (!driverId)
      return callback?.({ success: false, message: 'driverId is required' });

    const requestedSeats = seats || 1;

    // ── Departure datetime ────────────────────────────────────────────────────
    let departureDateTime = new Date();
    if (scheduledDate && scheduledTime) {
      const [year, month, day] = scheduledDate.split('-').map(Number);
      const [hour, minute] = scheduledTime.split(':').map(Number);
      departureDateTime = new Date(year, month - 1, day, hour, minute);
    }

    // ── Real distance & ETA (Google Maps) ─────────────────────────────────────
    let actualDistance = 0;
    let actualDuration = 0;
    try {
      const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
        { lat: pickup.lat, lng: pickup.lng },
        { lat: destination.lat, lng: destination.lng }
      );
      actualDistance = distanceKm;
      actualDuration = durationMinutes;
      console.log(`✅ Google Maps: ${actualDistance}km, ${actualDuration}min`);
    } catch {
      actualDistance = calculateDistance(
        { lat: pickup.lat, lng: pickup.lng },
        { lat: destination.lat, lng: destination.lng }
      );
      actualDuration = Math.ceil((actualDistance / 30) * 60);
      console.warn('⚠️ Google Maps failed — using Haversine fallback');
    }

    // ── Route geometry ────────────────────────────────────────────────────────
    let routeGeometry = {};
    try {
      routeGeometry = await getRouteGeometry(pickup, destination);
    } catch {
      console.warn('⚠️ Route geometry fetch failed — continuing without it');
    }

    // ── Fare breakdown ────────────────────────────────────────────────────────
    const fareBreakdown = await calculateFareBreakdown({
      distanceKm: actualDistance,
      departureDate: departureDateTime,
      departureTime: scheduledTime || new Date().toLocaleTimeString(),
      luggageCount: luggageCounts || 0,
      requestedSeats,
      rideType: type,
      waitingMinutes: 0,
    });

    const roundedBreakdown = roundObjectNumbers(fareBreakdown);
    const fareType = getFareType(departureDateTime);

    // ── Driver's default vehicle ──────────────────────────────────────────────
    const defaultVehicle = await Vehicle.findOne({
      userId: driverId,
      isDefault: true,
      isDeleted: false,
    })
      .select('_id')
      .lean();

    // ── Create Ride ───────────────────────────────────────────────────────────
    const ride = await Ride.create({
      driverId,
      vehicleId: defaultVehicle?._id,
      type,
      rideCreatedBy: userId,
      pickup: {
        address: pickup.address,
        coordinates: [pickup.lng, pickup.lat],
      },
      destination: {
        address: destination.address,
        coordinates: [destination.lng, destination.lat],
      },
      departureDate: scheduledDate || new Date().toISOString().split('T')[0],
      departureTime: scheduledTime || new Date().toLocaleTimeString(),
      totalSeats: requestedSeats,
      bookedSeats: 0,
      status: RIDE_STATUS.pending,
      routeGeometry,
    });

    // ── Create Passenger ──────────────────────────────────────────────────────
    const passenger = await Passenger.create({
      userId,
      rideId: ride._id,
      pickup: {
        address: pickup.address,
        coordinates: [pickup.lng, pickup.lat],
      },
      destination: {
        address: destination.address,
        coordinates: [destination.lng, destination.lat],
      },
      departureDate: scheduledDate || new Date().toISOString().split('T')[0],
      departureTime: scheduledTime || new Date().toLocaleTimeString(),
      requestedSeats,
      malePassengers: malePassengers || 0,
      femalePassengers: femalePassengers || 0,
      fareType,
      initialCharge: fareBreakdown.initialCharge,
      perKmCharge: fareBreakdown.perKmCharge,
      totalKmCharge: roundTo2(fareBreakdown.totalKmCharge),
      luggageCharge: fareBreakdown.luggageCharge,
      holidayTripCharge: fareBreakdown.holidaySurcharge,
      vat: fareBreakdown.vat,
      estimatedFare: roundTo2(fareBreakdown.totalFare),
      waitingCharge: fareBreakdown.waitingCharge || 0,
      estimatedDistanceKm: actualDistance,
      estimatedDurationMinutes: actualDuration,
      luggageCounts: luggageCounts || 0,
      note: note ?? '',
      status: PASSENGER_STATUS.pending,
    });

    const redis = getRedisClient();
    const io = getIO();

    // ── Check driver is online ────────────────────────────────────────────────
    const driverPos = await redis.geopos('drivers:location', driverId);
    if (!driverPos?.[0]?.[0]) {
      // Rollback ride & passenger
      await Promise.all([
        Ride.findByIdAndDelete(ride._id),
        Passenger.findByIdAndDelete(passenger._id),
      ]);
      return callback?.({
        success: false,
        message: 'Selected driver is not available',
      });
    }

    // ── Send request to driver ────────────────────────────────────────────────
    const roomSockets = await io.in(`driver:${driverId}`).fetchSockets();
    console.log(
      `🛋️ Room driver:${driverId} has ${roomSockets.length} socket(s)`
    );

    // ── Fetch rider info ──────────────────────────────────────────────────────────
    const rider = await User.findById(userId)
      .select('name profileImage avgRating phone')
      .lean();
    io.to(`driver:${driverId}`).emit('ride:new-request', {
      rideId: ride._id.toString(),
      passengerId: passenger._id.toString(),
      riderInfo: {
        name: rider?.name || '',
        profileImage: rider?.profileImage || null,
      },
      rideType: type,
      pickup,
      destination,
      requestedSeats,
      estimatedFare: roundedBreakdown.totalFare,
      distance: roundTo2(actualDistance),
      expiresIn: 30,
    });

    console.log(`📡 ride:new-request → driver:${driverId}`);

    // ── Timeout: cancel if driver doesn't respond in 30 min ──────────────────
    setTimeout(async () => {
      const current = await Ride.findById(ride._id).select('status').lean();
      if (current?.status === RIDE_STATUS.pending) {
        await Promise.all([
          Ride.findByIdAndUpdate(ride._id, {
            status: RIDE_STATUS.cancelled,
            cancellationReason: 'driver_timeout',
          }),
          Passenger.findByIdAndUpdate(passenger._id, {
            status: PASSENGER_STATUS.cancelled,
            cancellationReason: 'driver_timeout',
          }),
        ]);
        io.to(`user:${userId}`).emit('ride:driver-not-responded', {
          rideId: ride._id,
          message: 'Driver did not respond. Please try another driver.',
        });
        console.log(`⏰ Ride ${ride._id} cancelled — driver timeout`);
      }
    }, 30 * 60000);

    // ── Redis ─────────────────────────────────────────────────────────────────
    await redis.zadd('ride:matching:queue', Date.now(), ride._id.toString());
    await redis.hset(`ride:request:${ride._id}`, {
      userId,
      passengerId: passenger._id.toString(),
      pickup: JSON.stringify(pickup),
      destination: JSON.stringify(destination),
      seats: requestedSeats.toString(),
      estimatedFare: fareBreakdown.totalFare.toString(),
      timestamp: Date.now(),
    });
    await redis.expire(`ride:request:${ride._id}`, 1800); // 30 min

    socket.join(`ride:${ride._id}`);
    socket.join(`passenger:${passenger._id}`);

    return callback?.({
      success: true,
      message: 'Ride request sent to driver.',
      data: {
        rideId: ride._id,
        passengerId: passenger._id,
        estimatedFare: roundedBreakdown.totalFare,
        estimatedDistance: roundTo2(actualDistance),
        estimatedDuration: actualDuration,
        fareBreakdown: roundedBreakdown,
        rideDetails: {
          bookingDate: passenger.departureDate,
          bookingTime: passenger.departureTime,
          pickup: passenger.pickup,
          destination: passenger.destination,
          rideType: ride.type,
          carSeats: ride.totalSeats,
        },
      },
    });
  }
);
