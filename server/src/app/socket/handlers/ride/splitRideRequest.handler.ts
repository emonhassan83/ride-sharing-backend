// handlers/ride/splitRideRequest.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { User } from '../../../modules/user/user.model';
import { Vehicle } from '../../../modules/vehicle/vehicle.model';
import { calculateDistance } from '../../../utils/location.utils';
import { getFareType } from '../../../utils/time.utils';
import { roundTo2 } from '../../../utils/number.utils';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { haversineMeters } from '../../../utils/geo.utils';
import { notifyNearbyDriversForSplitRide } from '../../../utils/notifyDrivers.utils';
import { calcSplitPassengerFare } from '../../../utils/splitFare.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

const CORRIDOR_RADIUS_METERS = 10000;

function isPointNearRoute(
  lat: number,
  lng: number,
  routeCoordinates: number[][],
): boolean {
  if (!routeCoordinates?.length) return false;
  for (let i = 0; i < routeCoordinates.length - 1; i++) {
    const [lng1, lat1] = routeCoordinates[i];
    const [lng2, lat2] = routeCoordinates[i + 1];
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dx    = (lng2 - lng1) * Math.cos(toRad((lat1 + lat2) / 2));
    const dy    = lat2 - lat1;
    const denom = dx * dx + dy * dy || 1;
    const t     = Math.max(0, Math.min(1,
      ((lng - lng1) * Math.cos(toRad((lat1 + lat2) / 2)) * dx + (lat - lat1) * dy) / denom,
    ));
    const dist  = haversineMeters(
      lat, lng,
      lat1 + t * (lat2 - lat1),
      lng1 + t * (lng2 - lng1),
    );
    if (dist <= CORRIDOR_RADIUS_METERS) return true;
  }
  return false;
}

export const joinSplitRideRequestHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const {
      pickup, destination, seats,
      malePassengers, femalePassengers,
      scheduledDate, scheduledTime,
      luggageCounts, note,
    } = data;
    const userId = socket.auth?._id?.toString();

    if (!userId)
      return callback?.({ success: false, message: 'Unauthorized' });
    if (!pickup || !destination)
      return callback?.({ success: false, message: 'Pickup and destination are required' });
    if (!scheduledDate || !scheduledTime)
      return callback?.({ success: false, message: 'scheduledDate and scheduledTime are required' });

    const requestedSeats     = seats || 1;
    const [year, month, day] = scheduledDate.split('-').map(Number);
    const [hour, minute]     = scheduledTime.split(':').map(Number);
    const departureDateTime  = new Date(year, month - 1, day, hour, minute);

    // ── Find matching split rides ─────────────────────────────────────────────
    const nearbySplitRides = await Ride.find({
      type:          RIDE_TYPE.split,
      status:        { $in: [RIDE_STATUS.pending, RIDE_STATUS.accepted] },
      departureDate: scheduledDate,
      $expr:         { $gte: [{ $subtract: ['$totalSeats', '$bookedSeats'] }, requestedSeats] },
    }).lean();

    const matchingRides = nearbySplitRides.filter((ride) => {
      const coords = (ride as any).routeGeometry?.coordinates;
      if (!coords?.length) return false;
      return isPointNearRoute(pickup.lat, pickup.lng, coords);
    });

    if (!matchingRides.length)
      return callback?.({ success: false, message: 'No nearby split rides found for your route.' });

    // ── Distance & ETA ────────────────────────────────────────────────────────
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

    const fareType = getFareType(departureDateTime);
    const redis    = getRedisClient();
    const io       = getIO();

    const rider = await User.findById(userId)
      .select('name profileImage avgRating phone')
      .lean();

    const passengers:    any[] = [];
    const notifiedRides: any[] = [];

    for (const ride of matchingRides) {
      // ── Duplicate join check ──────────────────────────────────────────────
      const alreadyJoined = await Passenger.findOne({
        rideId: ride._id, userId,
        status: { $nin: [PASSENGER_STATUS.cancelled] },
      });
      if (alreadyJoined) continue;

      // ── Fare with correct totalSeats ──────────────────────────────────────
      const totalSeatsAfterJoin = (ride.bookedSeats || 0) + requestedSeats;
      const fareBreakdown = await calcSplitPassengerFare(
        actualDistance,
        requestedSeats,
        totalSeatsAfterJoin,
        luggageCounts || 0,
        scheduledTime,
        departureDateTime,
      );

      // ── Create Passenger ──────────────────────────────────────────────────
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
        perKmCharge:              fareBreakdown.totalKmCharge / (actualDistance || 1),
        totalKmCharge:            fareBreakdown.totalKmCharge,
        luggageCharge:            fareBreakdown.luggageCharge,
        holidayTripCharge:        fareBreakdown.holidayTripCharge,
        surchargePercent:         fareBreakdown.surchargePercent,
        surchargeAmount:          fareBreakdown.surchargeAmount,
        estimatedFare:            fareBreakdown.estimatedFare,
        waitingCharge:            0,
        estimatedDistanceKm:      actualDistance,
        estimatedDurationMinutes: actualDuration,
        luggageCounts:            luggageCounts || 0,
        note:                     note ?? '',
        status:                   PASSENGER_STATUS.pending,
      });

      passengers.push(passenger);
      socket.join(`ride:${ride._id}`);
      socket.join(`passenger:${passenger._id}`);

      // ── Vehicle info (if ride has a driver) ───────────────────────────────
      let vehicleInfo = null;
      const existingDriverId = (ride as any).driverId?.toString();
      if (existingDriverId) {
        const vehicle = await Vehicle.findOne({
          userId:    existingDriverId,
          isDefault: true,
          isDeleted: false,
        }).select('name number seats year').lean();

        if (vehicle) {
          vehicleInfo = {
            name:   vehicle.name,
            number: vehicle.number,
            seats:  vehicle.seats,
            year:   vehicle.year,
          };
        }
      }

      // ── Socket payload — same structure as getDriverRideRequest REST ──────
      const ridePayload = {
        rideId:           ride._id.toString(),
        passengerId:      passenger._id.toString(),
        riderInfo: {
          name:         rider?.name         || '',
          profileImage: rider?.profileImage || null,
          avgRating:    rider?.avgRating    || 0,
          phone:        rider?.phone        || '',
        },
        rideType:         'split',
        pickup: {
          address: pickup.address,
          lat:     pickup.lat,
          lng:     pickup.lng,
        },
        destination: {
          address: destination.address,
          lat:     destination.lat,
          lng:     destination.lng,
        },
        requestedSeats,
        malePassengers:   malePassengers   || 0,
        femalePassengers: femalePassengers || 0,
        luggageCount:     luggageCounts    || 0,
        note:             note             || '',
        estimatedFare:    fareBreakdown.estimatedFare,
        surchargePercent: fareBreakdown.surchargePercent,
        surchargeAmount:  fareBreakdown.surchargeAmount,
        distance:         roundTo2(actualDistance),
        departureDate:    scheduledDate,
        departureTime:    scheduledTime,
        availableSeats:   (ride.totalSeats - (ride.bookedSeats || 0)) - requestedSeats,
        vehicle:          vehicleInfo,
      };

      // ── Notify driver ─────────────────────────────────────────────────────
      if (existingDriverId) {
        // Ride already has driver → notify only that driver
        io.to(`driver:${existingDriverId}`).emit('ride:new-request', ridePayload);

        // FCM if driver offline
        const driverUser = await User.findById(existingDriverId)
          .select('fcmToken')
          .lean();

        if (driverUser?.fcmToken) {
          // sendPushNotification({
          //   fcmToken: driverUser.fcmToken,
          //   title:    'New Passenger Request!',
          //   body:     `A passenger wants to join your split ride from ${pickup.address || 'nearby'}`,
          //   data: {
          //     type:          'SPLIT_RIDE_REQUEST',
          //     rideId:        ride._id.toString(),
          //     passengerId:   passenger._id.toString(),
          //     estimatedFare: String(fareBreakdown.estimatedFare),
          //     departureDate: scheduledDate,
          //     departureTime: scheduledTime,
          //   },
          // }).catch(() => {});
        }
      } else {
        // No driver yet → notify nearby drivers along the route
        await notifyNearbyDriversForSplitRide(
          ride._id.toString(),
          (ride as any).routeGeometry,
          pickup,
          ridePayload,
          redis,
          io,
        );
      }

      // ── Redis ─────────────────────────────────────────────────────────────
      const ttl = Math.max(
        3600,
        Math.floor((departureDateTime.getTime() - Date.now()) / 1000) + 7200,
      );
      await redis.hset(`ride:request:${ride._id}:${passenger._id}`, {
        userId,
        passengerId:   passenger._id.toString(),
        rideId:        ride._id.toString(),
        estimatedFare: fareBreakdown.estimatedFare.toString(),
        timestamp:     Date.now().toString(),
      });
      await redis.expire(`ride:request:${ride._id}:${passenger._id}`, ttl);

      notifiedRides.push({
        rideId:           ride._id,
        passengerId:      passenger._id,
        estimatedFare:    fareBreakdown.estimatedFare,
        surchargePercent: fareBreakdown.surchargePercent,
        availableSeats:   (ride.totalSeats - (ride.bookedSeats || 0)) - requestedSeats,
        departureDate:    ride.departureDate,
        departureTime:    ride.departureTime,
        pickup:           { address: (ride as any).pickup.address },
        destination:      { address: (ride as any).destination.address },
      });
    }

    if (!passengers.length)
      return callback?.({ success: false, message: 'You have already joined all nearby split rides.' });

    return callback?.({
      success: true,
      message: `Request sent to ${notifiedRides.length} nearby split ride(s).`,
      data: {
        requestedRides:    notifiedRides,
        estimatedDistance: roundTo2(actualDistance),
        estimatedDuration: actualDuration,
      },
    });
  },
);