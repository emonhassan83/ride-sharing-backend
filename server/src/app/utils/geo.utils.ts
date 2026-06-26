// utils/geo.utils.ts
import { getRedisClient } from '../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../modules/ride/ride.constant';
import { Ride } from '../modules/ride/ride.model';
import { USER_ROLE, USER_STATUS } from '../modules/user/user.constant';
import { User } from '../modules/user/user.model';
import { Vehicle } from '../modules/vehicle/vehicle.model';
import { IDriverAvailability } from '../socket/interface/ride';
import { calculateDistance } from './location.utils';
import { getRealDistanceAndETA } from './maps.utils';

const DESTINATION_MATCH_RADIUS_KM = 5;

/**
 * Driver location set in Redis (GEOSET) and DB
 */
export async function saveDriverLocation(
  driverId: string,
  lat: number,
  lng: number
): Promise<void> {
  const redis = getRedisClient();

  // ── Redis GEOSET ──────────────────────────────────────────────────────────
  await redis.geoadd('drivers:location', lng, lat, driverId);

  // ── Redis current location (short TTL for live tracking) ─────────────────
  await redis.set(
    `driver:${driverId}:current`,
    JSON.stringify({ lat, lng, timestamp: Date.now() }),
    'EX',
    300
  );

  // ── DB — persist last location (fire-and-forget) ──────────────────────────
  User.findByIdAndUpdate(
    driverId,
    {
      location: {
        type: 'Point',
        coordinates: [lng, lat], // [lng, lat] — GeoJSON order
      },
    },
    { returnDocument: 'after' }
  ).catch((err) => console.error('Failed to save driver location to DB:', err));
}

/**
 * Driver location removed from Redis
 */
export async function removeDriverLocation(driverId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.zrem('drivers:location', driverId);
}

/**
 * Check driver has nearby location or not
 */
export async function isDriverNearPickup(
  driverId: string,
  pickupLat: number,
  pickupLng: number,
  thresholdMeters: number = 100
): Promise<{ isNear: boolean; distanceMeters: number } | null> {
  const redis = getRedisClient();

  const driverLocation = await redis.get(`driver:${driverId}:current`);
  if (!driverLocation) return null;

  const { lat, lng } = JSON.parse(driverLocation);
  const distanceMeters = calculateDistanceInMeters(
    lat,
    lng,
    pickupLat,
    pickupLng
  );

  return {
    isNear: distanceMeters <= thresholdMeters,
    distanceMeters: Math.round(distanceMeters),
  };
}

/**
 * Haversine formula: use for use calculation distance meters
 */
export function calculateDistanceInMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Redis GEOSEARCH use for search get nearby driver
 */
export async function findNearbyDrivers(
  pickupLat: number,
  pickupLng: number,
  radiusMeters: number = 5000
): Promise<Array<{ driverId: string; distanceMeters: number }>> {
  const redis = getRedisClient();

  const nearbyDrivers = (await redis.georadius(
    'drivers:location',
    pickupLng,
    pickupLat,
    radiusMeters,
    'm',
    'WITHDIST'
  )) as Array<[driverId: string, distance: string]>;

  return nearbyDrivers.map(([driverId, distance]) => ({
    driverId,
    distanceMeters: Math.round(parseFloat(distance)),
  }));
}

/**
 * Check driver availability for a ride request (new ride or join existing ride)
 *
 * @param driverId - Driver's user ID
 * @param requestedDate - Date string 'YYYY-MM-DD'
 * @param requestedTime - Time string 'HH:MM'
 * @param rideType - 'private' or 'split'
 * @param requestedSeats - Number of seats passenger wants
 * @param existingRideId - If joining an existing ride, provide ride ID; else undefined
 * @returns DriverAvailability object
 */
export async function hasDriverRideAtDateTime(
  driverId: string,
  requestedDate: string,
  requestedTime: string,
  rideType: string,
  requestedSeats: number
): Promise<IDriverAvailability> {
  // Convert "HH:MM" to minutes since midnight
  const toMinutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  const reqMinutes = toMinutes(requestedTime);

  // ── Find all active rides on same date ────────────────────────────────────
  const driverRides = await Ride.find({
    driverId,
    departureDate: requestedDate,
    status: {
      $nin: [
        RIDE_STATUS.rejected,
        RIDE_STATUS.cancelled,
        RIDE_STATUS.completed,
      ],
    },
  }).lean();

  if (!driverRides.length) {
    return { available: true, reason: 'Driver free' };
  }

  for (const ride of driverRides) {
    const rideMinutes = toMinutes(ride.departureTime);

    // ── Case 1: Exact same departure time ─────────────────────────────────
    if (rideMinutes === reqMinutes) {
      // Same split ride — check seats
      if (ride.type === RIDE_TYPE.split && rideType === 'split') {
        const availableSeats = (ride.totalSeats || 0) - (ride.bookedSeats || 0);
        if (availableSeats >= requestedSeats) {
          return {
            available: true,
            rideId: ride._id.toString(),
            reason: 'Join existing split ride',
          };
        }
        return { available: false, reason: 'Not enough seats in split ride' };
      }

      // Private ride at same time → always block
      return {
        available: false,
        reason: 'Driver has another ride at this time',
      };
    }

    // ── Case 2: Estimate trip duration (avg 30km/h, estimated distance) ───
    // We don't know exact duration, use estimatedDurationMinutes if available
    // Conservative estimate: assume 60 min minimum trip duration
    const estimatedTripDurationMinutes = 60;
    const rideEndMinutes = rideMinutes + estimatedTripDurationMinutes;

    // Does requested time overlap with this ride's window?
    const overlaps = reqMinutes >= rideMinutes && reqMinutes < rideEndMinutes;

    if (overlaps) {
      // ── Case 3: Requested during another ride's trip window ─────────────
      if (ride.type === RIDE_TYPE.split && rideType === 'split') {
        // Same route split ride (passenger pickup within trip) — allowed
        // Different time means different passenger pickup point
        const availableSeats = (ride.totalSeats || 0) - (ride.bookedSeats || 0);
        if (availableSeats >= requestedSeats) {
          return {
            available: true,
            rideId: ride._id.toString(),
            reason: 'Join existing split ride (en route pickup)',
          };
        }
        return { available: false, reason: 'Split ride in progress, no seats' };
      }

      // Private ride overlapping → block
      return {
        available: false,
        reason: 'Driver is on another trip at this time',
      };
    }

    // ── Case 4: New ride starts before current ride ends ──────────────────
    const newRideEndMinutes = reqMinutes + estimatedTripDurationMinutes;
    const reverseOverlap =
      rideMinutes >= reqMinutes && rideMinutes < newRideEndMinutes;

    if (reverseOverlap) {
      if (ride.type === RIDE_TYPE.split && rideType === 'split') {
        const availableSeats = (ride.totalSeats || 0) - (ride.bookedSeats || 0);
        if (availableSeats >= requestedSeats) {
          return {
            available: true,
            rideId: ride._id.toString(),
            reason: 'Join existing split ride',
          };
        }
        return { available: false, reason: 'Not enough seats' };
      }
      return {
        available: false,
        reason: 'New ride would conflict with upcoming trip',
      };
    }
  }

  return { available: true, reason: 'Driver free' };
}

/**
 * Find drivers within radius and enrich with details
 */
export async function fetchDriversWithinRadius(
  redis: any,
  lng: number,
  lat: number,
  radiusKm: number,
  rideType: string,
  requestedSeats: number,
  passengerDestination: { lat: number; lng: number },
  departureDate: string,
  departureTime: string
): Promise<any[]> {
  // ── Step 1: Online drivers from Redis GEOSET ──────────────────────────────
  type GeoRadiusResult = Array<[driverId: string, distance: string]>;
  const onlineDrivers = (await redis.georadius(
    'drivers:location',
    lng,
    lat,
    radiusKm,
    'km',
    'WITHDIST'
  )) as GeoRadiusResult;

  // ── Step 2: Nearby drivers from DB (includes offline) ────────────────────
  const dbDrivers = await User.find({
    role: USER_ROLE.provider,
    isDeleted: false,
    status: USER_STATUS.active,
    location: {
      $nearSphere: {
        $geometry: {
          type: 'Point',
          coordinates: [lng, lat],
        },
        $maxDistance: radiusKm * 1000, // meters
      },
    },
  })
    .select('_id name email phone avgRating profileImage location')
    .lean();

  // ── Step 3: Merge — DB drivers as base, Redis distance overrides ──────────
  const onlineMap = new Map(
    onlineDrivers.map(([driverId, dist]) => [driverId, parseFloat(dist)])
  );

  // Build merged driver list (DB as source of truth for all nearby)
  const mergedDriverIds = new Map<
    string,
    { driverId: string; geoDistanceKm: number }
  >();

  // Add DB drivers
  for (const dbDriver of dbDrivers) {
    const id = dbDriver._id.toString();
    const coords = dbDriver.location?.coordinates;
    if (!coords || (coords[0] === 0 && coords[1] === 0)) continue;

    const distKm = calculateDistance(
      { lat, lng },
      { lat: coords[1], lng: coords[0] }
    );
    mergedDriverIds.set(id, { driverId: id, geoDistanceKm: distKm });
  }

  // Override distance with Redis geo distance if online (more accurate)
  for (const [driverId, dist] of onlineMap) {
    if (mergedDriverIds.has(driverId)) {
      mergedDriverIds.get(driverId)!.geoDistanceKm = dist;
    }
  }

  if (!mergedDriverIds.size) return [];

  const driversData: any[] = [];

  for (const { driverId, geoDistanceKm } of mergedDriverIds.values()) {
    // ── Availability check ──────────────────────────────────────────────────
    const availability = await hasDriverRideAtDateTime(
      driverId,
      departureDate,
      departureTime,
      rideType,
      requestedSeats
    );
    if (!availability.available) continue;

    // ── Driver details: Redis first, DB fallback ────────────────────────────
    let driverName = 'Unknown';
    let driverEmail = '';
    let driverPhone = '';
    let driverRating = 5;
    let driverPhoto: string | null = null;
    let vehicleModel = 'Standard';
    let vehicleNumber = '';
    let totalSeats = 4;
    let bookedSeats = 0;
    let driverDestination: any = null;
    let driverLastLat = lat;
    let driverLastLng = lng;
    const isOnline = onlineMap.has(driverId);

    const driverDetails = await redis.hgetall(`driver:${driverId}:details`);

    if (driverDetails && Object.keys(driverDetails).length > 0) {
      driverName = driverDetails.name || 'Unknown';
      driverEmail = driverDetails.email || '';
      driverPhone = driverDetails.phone || '';
      driverRating = parseFloat(driverDetails.rating) || 5;
      driverPhoto = driverDetails.photo || null;
      vehicleModel = driverDetails.vehicleModel || 'Standard';
      vehicleNumber = driverDetails.vehicleNumber || '';
      totalSeats = parseInt(driverDetails.seats) || 4;
      bookedSeats = parseInt(driverDetails.bookedSeats) || 0;
      driverLastLat = parseFloat(driverDetails.lastLat) || lat;
      driverLastLng = parseFloat(driverDetails.lastLng) || lng;
      if (driverDetails.destination) {
        try {
          driverDestination = JSON.parse(driverDetails.destination);
        } catch {
          /* ignore */
        }
      }
    } else {
      // DB fallback
      const dbDriver = dbDrivers.find((d) => d._id.toString() === driverId);
      const vehicle = await Vehicle.findOne({
        userId: driverId,
        isDefault: true,
        isDeleted: false,
      }).lean();

      driverName = dbDriver?.name || 'Unknown';
      driverEmail = dbDriver?.email || '';
      driverPhone = dbDriver?.phone || '';
      driverRating = dbDriver?.avgRating || 5;
      driverPhoto = dbDriver?.profileImage || null;
      vehicleModel = vehicle?.name || 'Standard';
      vehicleNumber = vehicle?.number || '';
      totalSeats = vehicle?.seats || 4;
      bookedSeats = 0;

      if (dbDriver?.location?.coordinates) {
        driverLastLng = dbDriver.location.coordinates[0];
        driverLastLat = dbDriver.location.coordinates[1];
      }
    }

    // ── Current location: Redis current > Redis hash > DB ───────────────────
    try {
      const currentRaw = await redis.get(`driver:${driverId}:current`);
      if (currentRaw) {
        const current = JSON.parse(currentRaw);
        driverLastLat = current.lat;
        driverLastLng = current.lng;
      }
    } catch {
      /* ignore */
    }

    const availableSeats = totalSeats - bookedSeats;

    // ── Seat check ──────────────────────────────────────────────────────────
    if (rideType === 'private' && totalSeats < requestedSeats) continue;
    if (rideType === 'split' && availableSeats < requestedSeats) continue;

    // ── Destination match for split ─────────────────────────────────────────
    if (rideType === 'split' && driverDestination) {
      const distToDest = calculateDistance(
        { lat: driverDestination.lat, lng: driverDestination.lng },
        { lat: passengerDestination.lat, lng: passengerDestination.lng }
      );
      if (distToDest > DESTINATION_MATCH_RADIUS_KM) continue;
    }

    // ── Google Maps distance & ETA ──────────────────────────────────────────
    let realDistance = geoDistanceKm;
    let etaMinutes = Math.round((geoDistanceKm / 30) * 60);

    try {
      const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
        { lat: driverLastLat, lng: driverLastLng },
        { lat, lng }
      );
      realDistance = distanceKm;
      etaMinutes = durationMinutes;
    } catch {
      console.warn(`⚠️ Google Maps fallback for driver ${driverId}`);
    }

    driversData.push({
      driverId,
      driverName,
      driverEmail,
      driverPhone,
      driverRating,
      driverPhoto,
      isOnline, // ✅ online/offline indicator
      vehicle: {
        model: vehicleModel,
        number: vehicleNumber,
        seats: totalSeats,
        availableSeats,
      },
      location: { lat: driverLastLat, lng: driverLastLng },
      distance: parseFloat(realDistance.toFixed(2)),
      eta: Math.round(etaMinutes),
    });
  }

  return driversData;
}

export const haversineMeters = (
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number => {
  const R = 6378100;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const CORRIDOR_RADIUS_METERS = 10000; // 10 km corridor
export function isPointNearRoute(
  lat: number,
  lng: number,
  routeCoordinates: number[][]
): boolean {
  if (!routeCoordinates?.length) return false;
  for (let i = 0; i < routeCoordinates.length - 1; i++) {
    const [lng1, lat1] = routeCoordinates[i];
    const [lng2, lat2] = routeCoordinates[i + 1];
    const dist = pointToSegmentDistance(lat, lng, lat1, lng1, lat2, lng2);
    if (dist <= CORRIDOR_RADIUS_METERS) return true;
  }
  return false;
}

// Point to line segment distance (meters)
function pointToSegmentDistance(
  pLat: number,
  pLng: number,
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const R = 6371000;

  // Convert to radians
  const toRad = (d: number) => (d * Math.PI) / 180;

  // Use simple planar approximation for short distances
  const dx = (bLng - aLng) * Math.cos(toRad((aLat + bLat) / 2));
  const dy = bLat - aLat;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((pLng - aLng) * Math.cos(toRad((aLat + bLat) / 2)) * dx +
        (pLat - aLat) * dy) /
        (dx * dx + dy * dy || 1)
    )
  );

  const closestLng = aLng + t * (bLng - aLng);
  const closestLat = aLat + t * (bLat - aLat);

  return haversineMeters(pLat, pLng, closestLat, closestLng);
}
