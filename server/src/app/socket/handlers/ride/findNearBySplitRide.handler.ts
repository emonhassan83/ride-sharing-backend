// handlers/ride/findNearbySplitRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { calculateDistance } from '../../../utils/location.utils';
import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';
import { Ride } from '../../../modules/ride/ride.model';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { TUser } from '../../../modules/user/user.interface';
import { TVehicle } from '../../../modules/vehicle/vehicle.interface';
import { User } from '../../../modules/user/user.model';
import { ISplitRideRequest } from '../../interface/ride';
import {
  isRequestEligibleForSplitRide,
  requestToMatchCandidate,
} from '../../../utils/splitMatching.utils';
import {
  assertMinimumBookingLeadTime,
  assertSplitMinimumDistance,
} from '../../../utils/rideSchedule.utils';
import {
  normalizeAndAssertLuggage,
  toLuggageFyiView,
  vehicleFitsParty,
} from '../../../utils/luggage.utils';

export const findNearbySplitRideHandler = eventHandler<ISplitRideRequest>(
  async (
    socket: TSocket,
    data: ISplitRideRequest | undefined,
    callback?: any
  ) => {
    if (!data) return callback?.({ success: false, message: 'Invalid data' });

    const {
      pickup,
      destination,
      departureDate,
      departureTime,
      passengers,
      largeSuitcase,
      smallSuitcase,
      luggageNote,
      note,
    } = data;
    const requestedSeats = Number(passengers) > 0 ? Number(passengers) : 1;
    const luggage = normalizeAndAssertLuggage({
      largeSuitcase,
      smallSuitcase,
      luggageNote,
      requestedSeats,
    });

    if (!pickup || !destination)
      return callback?.({ success: false, message: 'Pickup and destination are required' });
    if (!departureDate || !departureTime)
      return callback?.({
        success: false,
        message: 'departureDate and departureTime are required',
      });

    // Same business gates as automatic / join matching.
    await assertMinimumBookingLeadTime(departureDate, departureTime, RIDE_TYPE.split);

    let routeDistanceKm = 0;
    try {
      const maps = await getRealDistanceAndETA(
        { lat: pickup.lat, lng: pickup.lng },
        { lat: destination.lat, lng: destination.lng },
      );
      routeDistanceKm = maps.distanceKm;
    } catch {
      routeDistanceKm = calculateDistance(
        { lat: pickup.lat, lng: pickup.lng },
        { lat: destination.lat, lng: destination.lng },
      );
    }
    await assertSplitMinimumDistance(routeDistanceKm);

    const matchRequest = requestToMatchCandidate({
      pickup: { lat: pickup.lat, lng: pickup.lng },
      destination: { lat: destination.lat, lng: destination.lng },
      departureDate,
      departureTime,
    });

    const redisClient = getRedisClient();

    type GeoRadiusResult = Array<[driverId: string, distance: string]>;
    let nearbyDrivers = (await redisClient.georadius(
      'drivers:location',
      pickup.lng,
      pickup.lat,
      5,
      'km',
      'WITHDIST'
    )) as GeoRadiusResult;

    if (!nearbyDrivers.length) {
      nearbyDrivers = (await redisClient.georadius(
        'drivers:location',
        pickup.lng,
        pickup.lat,
        10,
        'km',
        'WITHDIST'
      )) as GeoRadiusResult;
    }

    const nearbyDriverIds = nearbyDrivers.map((e) => e[0]);

    const driverLocationMap: Record<
      string,
      { lat: number; lng: number } | null
    > = {};
    await Promise.all(
      nearbyDriverIds.map(async (driverId) => {
        try {
          const raw = await redisClient.get(`driver:${driverId}:current`);
          if (raw) {
            const { lat, lng } = JSON.parse(raw);
            driverLocationMap[driverId] = { lat, lng };
          } else {
            const user = await User.findById(driverId).select('location').lean();
            const coords = user?.location?.coordinates;
            if (coords && (coords[0] !== 0 || coords[1] !== 0)) {
              driverLocationMap[driverId] = { lat: coords[1], lng: coords[0] };
            } else {
              driverLocationMap[driverId] = null;
            }
          }
        } catch {
          driverLocationMap[driverId] = null;
        }
      })
    );

    const rides = await Ride.find({
      type: RIDE_TYPE.split,
      splitFareLocked: { $ne: true },
      status: { $in: [RIDE_STATUS.pending, RIDE_STATUS.accepted] },
      departureDate,
      $or: [
        { totalSeats: 0 },
        { $expr: { $gte: [{ $subtract: ['$totalSeats', '$bookedSeats'] }, requestedSeats] } },
      ],
    })
      .populate<{ driverId: TUser }>(
        'driverId',
        'name email profileImage avgRating phone gender location'
      )
      .populate<{ vehicleId: TVehicle }>('vehicleId', 'name number year seats')
      .lean();

    const eligibleRides: any[] = [];
    for (const ride of rides) {
      const eligibility = await isRequestEligibleForSplitRide(matchRequest, ride, {
        requirePaidBooking: true,
        requestedSeats,
      });
      if (!eligibility.ok) continue;

      const vehicleSeats = Number((ride as any).vehicleId?.seats) || 0;
      if (!vehicleFitsParty(vehicleSeats, requestedSeats)) continue;

      eligibleRides.push({
        ride,
        usedSeats: eligibility.usedSeats,
        matchedRiders: eligibility.activePassengers.length,
      });
    }

    const drivers = await Promise.all(
      eligibleRides.map(async ({ ride, usedSeats, matchedRiders }: any) => {
        const driver = ride.driverId as (TUser & { _id: any; email?: string; location?: { coordinates: number[] } }) | null;
        const vehicle = ride.vehicleId as (TVehicle & { _id: any }) | null;

        const hasDriver = !!(driver && vehicle);

        let driverLocation: { lat: number; lng: number } | null =
          driverLocationMap[driver?._id?.toString()] ?? null;
        if (!driverLocation && driver) {
          const coords = driver?.location?.coordinates;
          if (coords && (coords[0] !== 0 || coords[1] !== 0)) {
            driverLocation = { lat: coords[1], lng: coords[0] };
          }
        }

        let distance = 0;
        let eta = 0;
        if (hasDriver) {
          const from = driverLocation
            ? { lat: driverLocation.lat, lng: driverLocation.lng }
            : { lat: ride.pickup.coordinates[1], lng: ride.pickup.coordinates[0] };
          try {
            const maps = await getRealDistanceAndETA(from, { lat: pickup.lat, lng: pickup.lng });
            distance = parseFloat(maps.distanceKm.toFixed(2));
            eta = Math.round(maps.durationMinutes);
          } catch {
            /* keep 0 defaults */
          }
        }

        const availableSeats = ride.totalSeats > 0 ? ride.totalSeats - usedSeats : null;

        return {
          rideId: ride._id,
          hasDriver,
          driverId: driver?._id ?? null,
          driverName: driver?.name ?? null,
          driverEmail: driver?.email ?? null,
          driverPhone: driver?.phone ?? null,
          driverPhoto: driver?.profileImage ?? null,
          driverRating: driver?.avgRating ?? null,
          vehicle: hasDriver ? {
            model: vehicle?.name,
            number: vehicle?.number,
            seats: vehicle?.seats,
            availableSeats,
          } : null,
          location: driverLocation,
          distance,
          eta,
          departureTime: ride.departureTime,
          departureDate: ride.departureDate,
          requiredVehicleClass: luggage.vehicleClass,
          status: ride.status,
          matchedRiders,
          availableSeats,
          pickup: {
            address: ride.pickup?.address ?? null,
            lat: ride.pickup?.coordinates?.[1],
            lng: ride.pickup?.coordinates?.[0],
          },
          destination: {
            address: ride.destination?.address ?? null,
            lat: ride.destination?.coordinates?.[1],
            lng: ride.destination?.coordinates?.[0],
          },
        };
      })
    );

    callback?.({
      success: true,
      message: `${drivers.length} matching split ride(s) found`,
      data: {
        pickup: {
          lat: pickup.lat,
          lng: pickup.lng,
          address: pickup.address ?? null,
        },
        destination: {
          lat: destination.lat,
          lng: destination.lng,
          address: destination.address ?? null,
        },
        driverCount: drivers.length,
        rideCount: drivers.length,
        requiredVehicleClass: luggage.vehicleClass,
        luggage: {
          ...toLuggageFyiView({ ...luggage, note }),
          ...luggage.sizeGuide,
          vehicleClass: luggage.vehicleClass,
        },
        /** Pass this ride's rideId to ride:join-split-ride to add the order under it. */
        drivers,
        rides: drivers,
      },
    });
  }
);
