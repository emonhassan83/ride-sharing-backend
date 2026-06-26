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
import { User } from '../../../modules/user/user.model';
import { ISplitRideRequest } from '../../interface/ride';

export const findNearbySplitRideHandler = eventHandler<ISplitRideRequest>(
  async (
    socket: TSocket,
    data: ISplitRideRequest | undefined,
    callback?: any
  ) => {
    if (!data) return callback?.({ success: false, message: 'Invalid data' });

    const { pickup, destination, departureDate, passengers } = data;

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

    // ── DB query — basic filter only ──────────────────────────────────────────
    const rides = await Ride.find({
      type: RIDE_TYPE.split,
      status: { $in: [RIDE_STATUS.pending, RIDE_STATUS.accepted, RIDE_STATUS.started] },
      departureDate,
      $expr: {
        $gte: [{ $subtract: ['$totalSeats', '$bookedSeats'] }, passengers],
      },
    })
      .populate<{ driverId: TUser }>(
        'driverId',
        'name email profileImage avgRating phone gender location'
      )
      .populate<{ vehicleId: TVehicle }>('vehicleId', 'name number year seats')
      .lean();

    // ── Application level corridor + direction filter ─────────────────────────
    const filteredRides = rides.filter((ride: any) => {
      const coords = ride.routeGeometry?.coordinates ?? [];
      if (!coords.length) return false;

      // Client sends lat/lng with swapped names vs GeoJSON convention;
      // isPointNearRoute expects standard (lat, lng) matching GeoJSON [lng, lat] decoding.
      const pickupNear = isPointNearRoute(pickup.lng, pickup.lat, coords);
      if (!pickupNear) return false;

      const destNear = isPointNearRoute(destination.lng, destination.lat, coords);
      if (!destNear) return false;

      // Direction check — pickup index must appear before destination index on route
      let pickupIdx = -1, destIdx = -1;
      let pickupDist = Infinity, destDist = Infinity;

      coords.forEach(([lng, lat]: [number, number], i: number) => {
        const pd = haversineMeters(pickup.lng, pickup.lat, lat, lng);
        const dd = haversineMeters(destination.lng, destination.lat, lat, lng);
        if (pd < pickupDist) { pickupDist = pd; pickupIdx = i; }
        if (dd < destDist) { destDist = dd; destIdx = i; }
      });

      return destIdx > pickupIdx;
    });

    // ── Build response ────────────────────────────────────────────────────────
    const drivers = await Promise.all(
      filteredRides
        .filter((ride: any) => ride.driverId && ride.vehicleId) // skip rides with deleted/missing driver or vehicle
        .map(async (ride: any) => {
        const driver = ride.driverId as TUser & { _id: any; email?: string; location?: { coordinates: number[] } };
        const vehicle = ride.vehicleId as TVehicle & { _id: any };

        // Redis real-time location → DB populated location → ride pickup fallback
        let driverLocation: { lat: number; lng: number } | null =
          driverLocationMap[driver?._id?.toString()] ?? null;
        if (!driverLocation) {
          const coords = driver?.location?.coordinates;
          if (coords && (coords[0] !== 0 || coords[1] !== 0)) {
            driverLocation = { lat: coords[1], lng: coords[0] };
          }
        }

        // Distance & ETA from driver's current position to user's pickup
        const from = driverLocation
          ? { lat: driverLocation.lat, lng: driverLocation.lng }
          : { lat: ride.pickup.coordinates[1], lng: ride.pickup.coordinates[0] };

        let distance = 0;
        let eta = 0;
        try {
          const maps = await getRealDistanceAndETA(from, {
            lat: pickup.lat,
            lng: pickup.lng,
          });
          distance = parseFloat(maps.distanceKm.toFixed(2));
          eta = Math.round(maps.durationMinutes);
        } catch {
          /* keep 0 defaults */
        }

        return {
          driverId: driver?._id,
          driverName: driver?.name,
          driverEmail: driver?.email ?? null,
          driverPhone: driver?.phone,
          driverPhoto: driver?.profileImage,
          driverRating: driver?.avgRating,
          vehicle: {
            model: vehicle?.name,
            number: vehicle?.number,
            seats: vehicle?.seats,
            availableSeats: ride.totalSeats - ride.bookedSeats,
          },
          location: driverLocation,
          distance,
          eta,
          departureTime: ride.departureTime,
          departureDate: ride.departureDate,
        };
      })
    );

    callback?.({
      success: true,
      message: `${drivers.length} nearby split ride(s) found`,
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
        drivers,
      },
    });
  }
);
