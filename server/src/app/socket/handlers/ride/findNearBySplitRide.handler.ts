// handlers/ride/findNearbySplitRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { haversineMeters, isPointNearRoute } from '../../../utils/geo.utils';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';
import { Ride } from '../../../modules/ride/ride.model';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { TUser } from '../../../modules/user/user.interface';
import { TVehicle } from '../../../modules/vehicle/vehicle.interface';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { User } from '../../../modules/user/user.model';
import { ISplitRideRequest } from '../../interface/ride';

export const findNearbySplitRideHandler = eventHandler<ISplitRideRequest>(
  async (
    socket: TSocket,
    data: ISplitRideRequest | undefined,
    callback?: any
  ) => {
    if (!data) return callback?.({ success: false, message: 'Invalid data' });

    const { pickup, destination, departureDate, departureTime, passengers } =
      data;

    const CORRIDOR_RADIUS_METERS = 5000; // ✅ 5km corridor
    const EARTH_RADIUS_METERS = 6378100;

    const redisClient = getRedisClient();

    // ── Find nearby drivers ───────────────────────────────────────────────────
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

    // ── Driver current locations ──────────────────────────────────────────────
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
            // DB fallback
            const user = await User.findById(driverId)
              .select('location')
              .lean();
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

    // ── DB query — basic filter only ──────────────────────────────────────────
    const rides = await Ride.find({
      type: RIDE_TYPE.split,
      status: RIDE_STATUS.accepted,
      departureDate,
      driverId: { $in: nearbyDriverIds },
      $expr: {
        $gte: [{ $subtract: ['$totalSeats', '$bookedSeats'] }, passengers],
      },
    })
      .populate<{ driverId: TUser }>(
        'driverId',
        'name profileImage avgRating phone gender'
      )
      .populate<{ vehicleId: TVehicle }>('vehicleId', 'name number year seats')
      .lean();

    const rideIds = rides.map((r: any) => r._id.toString());
    const passengersInfos = await Passenger.find({ rideId: { $in: rideIds } })
      .select('rideId requestedSeats malePassengers femalePassengers')
      .lean();

    // ── Application level corridor + direction filter ─────────────────────────
    const filteredRides = rides.filter((ride: any) => {
      const coords = ride.routeGeometry?.coordinates ?? [];
      if (!coords.length) return false;

      // Check pickup is near route
      const pickupNear = isPointNearRoute(
        pickup.lat,
        pickup.lng,
        coords,
        CORRIDOR_RADIUS_METERS
      );
      if (!pickupNear) return false;

      // Check destination is near route
      const destNear = isPointNearRoute(
        destination.lat,
        destination.lng,
        coords,
        CORRIDOR_RADIUS_METERS
      );
      if (!destNear) return false;

      // Direction check — pickup index < destination index on route
      let pickupIdx = -1,
        destIdx = -1;
      let pickupDist = Infinity,
        destDist = Infinity;

      coords.forEach(([lng, lat]: [number, number], i: number) => {
        const pd = haversineMeters(pickup.lat, pickup.lng, lat, lng);
        const dd = haversineMeters(destination.lat, destination.lng, lat, lng);
        if (pd < pickupDist) {
          pickupDist = pd;
          pickupIdx = i;
        }
        if (dd < destDist) {
          destDist = dd;
          destIdx = i;
        }
      });

      return destIdx > pickupIdx;
    });

    // ── Group passengers by rideId ────────────────────────────────────────────
    const passengersByRideId = passengersInfos.reduce(
      (acc: Record<string, typeof passengersInfos>, p: any) => {
        const key = p.rideId.toString();
        if (!acc[key]) acc[key] = [];
        acc[key].push(p);
        return acc;
      },
      {}
    );

    // ── Build response ────────────────────────────────────────────────────────
    const addMinutesToTime = (time: string, minutes: number): string => {
      const [h, m] = time.split(':').map(Number);
      const total = h * 60 + m + minutes;
      const hh = Math.floor(total / 60) % 24;
      const mm = total % 60;
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    };

    const result = await Promise.all(
      filteredRides.map(async (ride: any) => {
        const driver = ride.driverId as TUser & { _id: any };
        const vehicle = ride.vehicleId as TVehicle & { _id: any };
        const ridePassengers = passengersByRideId[ride._id.toString()] ?? [];

        const totalRequestedSeats = ridePassengers.reduce(
          (s: number, p: any) => s + (p.requestedSeats ?? 0),
          0
        );
        const totalMale = ridePassengers.reduce(
          (s: number, p: any) => s + (p.malePassengers ?? 0),
          0
        );
        const totalFemale = ridePassengers.reduce(
          (s: number, p: any) => s + (p.femalePassengers ?? 0),
          0
        );

        const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
          { lat: ride.pickup.coordinates[1], lng: ride.pickup.coordinates[0] },
          { lat: pickup.lat, lng: pickup.lng }
        );

        const estimatedPickupTime = addMinutesToTime(
          ride.departureTime,
          durationMinutes
        );

        return {
          ride: {
            _id: ride._id,
            type: ride.type,
            status: ride.status,
            departureDate: ride.departureDate,
            departureTime: ride.departureTime,
            estimatedPickupTime,
            distanceFromRidePickupToUserPickupKm: distanceKm,
            totalSeats: ride.totalSeats,
            bookedSeats: ride.bookedSeats,
            availableSeats: ride.totalSeats - ride.bookedSeats,
            pickup: ride.pickup,
            destination: ride.destination,
          },
          requestedPickup: {
            address: pickup.address ?? null,
            coordinates: [pickup.lng, pickup.lat],
          },
          requestedDestination: {
            address: destination.address ?? null,
            coordinates: [destination.lng, destination.lat],
          },
          driver: {
            _id: driver?._id,
            name: driver?.name,
            profileImage: driver?.profileImage,
            avgRating: driver?.avgRating,
            phone: driver?.phone,
            gender: driver?.gender,
            currentLocation: driverLocationMap[driver?._id?.toString()] ?? null,
          },
          vehicle: {
            _id: vehicle?._id,
            name: vehicle?.name,
            number: vehicle?.number,
            year: vehicle?.year,
            seats: vehicle?.seats,
          },
          passengers: {
            count: ridePassengers.length,
            totalRequestedSeats,
            totalMale,
            totalFemale,
          },
        };
      })
    );

    callback?.({
      success: true,
      message: `${result.length} nearby split ride(s) found`,
      data: result,
    });
  }
);
