// utils/notifyDrivers.utils.ts
import { User } from '../modules/user/user.model';
import { USER_ROLE, USER_STATUS } from '../modules/user/user.constant';
import { haversineMeters } from './geo.utils';

const CORRIDOR_RADIUS_METERS = 10000;

// Point to line segment distance in meters
function pointToSegmentMeters(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dx    = (bLng - aLng) * Math.cos(toRad((aLat + bLat) / 2));
  const dy    = bLat - aLat;
  const denom = dx * dx + dy * dy || 1;
  const t     = Math.max(0, Math.min(1,
    ((pLng - aLng) * Math.cos(toRad((aLat + bLat) / 2)) * dx + (pLat - aLat) * dy) / denom,
  ));
  return haversineMeters(pLat, pLng, aLat + t * (bLat - aLat), aLng + t * (bLng - aLng));
}

export async function notifyNearbyDrivers(
  rideId:      string,
  pickup:      { lat: number; lng: number },
  ridePayload: any,
  redis:       any,
  io:          any,
  radiusKm     = 10,
): Promise<number> {
  let notifiedCount = 0;

  // ── Online drivers from Redis GEOSET ─────────────────────────────────────
  type GeoResult = Array<[string, string]>;
  const onlineDrivers = (await redis.georadius(
    'drivers:location', pickup.lng, pickup.lat, radiusKm, 'km', 'WITHDIST',
  )) as GeoResult;

  const onlineDriverIds = new Set(onlineDrivers.map(([id]) => id));

  // ── Notify online drivers via socket ─────────────────────────────────────
  for (const [driverId] of onlineDrivers) {
    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    io.to(`driver:${driverId}`).emit('ride:new-request', ridePayload);
    notifiedCount++;
  }

  // ── Offline drivers from DB (within radius) ───────────────────────────────
  const offlineDrivers = await User.find({
    role:      USER_ROLE.provider,
    isDeleted: false,
    status:    USER_STATUS.active,
    fcmToken:  { $ne: null },
    location: {
      $nearSphere: {
        $geometry:    { type: 'Point', coordinates: [pickup.lng, pickup.lat] },
        $maxDistance: radiusKm * 1000,
      },
    },
  })
    .select('_id fcmToken')
    .lean();

  for (const driver of offlineDrivers) {
    const driverId = driver._id.toString();

    // Skip if already online (already notified via socket)
    if (onlineDriverIds.has(driverId)) continue;

    // Skip if already rejected
    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    // FCM push notification
    if (driver.fcmToken) {
      try {
        // await sendPushNotification({
        //   fcmToken: driver.fcmToken,
        //   title:    'New Ride Request!',
        //   body:     `${ridePayload.rideType} ride from ${ridePayload.pickup?.address || 'nearby'}`,
        //   data: {
        //     type:          'RIDE_REQUEST',
        //     rideId,
        //     passengerId:   ridePayload.passengerId,
        //     estimatedFare: String(ridePayload.estimatedFare),
        //     departureDate: ridePayload.departureDate,
        //     departureTime: ridePayload.departureTime,
        //   },
        // });
        notifiedCount++;
      } catch (err) {
        console.warn(`FCM failed for driver ${driverId}:`, err);
      }
    }
  }

  return notifiedCount;
}

export async function notifyNearbyDriversForSplitRide(
  rideId:        string,
  routeGeometry: { type: string; coordinates: number[][] } | null,
  pickup:        { lat: number; lng: number },
  ridePayload:   any,
  redis:         any,
  io:            any,
): Promise<number> {
  let notifiedCount = 0;

  // ── Helper: check if point is within corridor of route ────────────────────
  const isNearRoute = (lat: number, lng: number): boolean => {
    if (!routeGeometry?.coordinates?.length) return true; // no route — notify all

    for (let i = 0; i < routeGeometry.coordinates.length - 1; i++) {
      const [lng1, lat1] = routeGeometry.coordinates[i];
      const [lng2, lat2] = routeGeometry.coordinates[i + 1];
      const dist = pointToSegmentMeters(lat, lng, lat1, lng1, lat2, lng2);
      if (dist <= CORRIDOR_RADIUS_METERS) return true;
    }
    return false;
  };

  // ── Online drivers from Redis GEOSET ──────────────────────────────────────
  type GeoResult = Array<[string, string]>;
  const onlineDrivers = (await redis.georadius(
    'drivers:location', pickup.lng, pickup.lat, 15, 'km', 'WITHDIST',
  )) as GeoResult;

  const onlineDriverIds = new Set(onlineDrivers.map(([id]) => id));

  for (const [driverId] of onlineDrivers) {
    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    // Check driver's current location is near route
    try {
      const raw = await redis.get(`driver:${driverId}:current`);
      if (raw) {
        const { lat, lng } = JSON.parse(raw);
        if (!isNearRoute(lat, lng)) continue;
      }
    } catch { /* ignore — notify anyway */ }

    io.to(`driver:${driverId}`).emit('ride:new-request', ridePayload);
    notifiedCount++;
  }

  // ── Offline drivers from DB ────────────────────────────────────────────────
  const offlineDrivers = await User.find({
    role:      USER_ROLE.provider,
    isDeleted: false,
    status:    USER_STATUS.active,
    fcmToken:  { $ne: null },
    location: {
      $nearSphere: {
        $geometry:    { type: 'Point', coordinates: [pickup.lng, pickup.lat] },
        $maxDistance: 15000, // 15km
      },
    },
  }).select('_id fcmToken location').lean();

  for (const driver of offlineDrivers) {
    const driverId = driver._id.toString();
    if (onlineDriverIds.has(driverId)) continue;

    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    // Check if driver location is near route
    const coords = driver.location?.coordinates;
    if (coords && !isNearRoute(coords[1], coords[0])) continue;

    if (driver.fcmToken) {
      try {
        // await sendPushNotification({
        //   fcmToken: driver.fcmToken,
        //   title:    'New Split Ride Request!',
        //   body:     `Split ride from ${ridePayload.pickup?.address || 'nearby'}`,
        //   data: {
        //     type:          'SPLIT_RIDE_REQUEST',
        //     rideId,
        //     passengerId:   ridePayload.passengerId,
        //     estimatedFare: String(ridePayload.estimatedFare),
        //     departureDate: ridePayload.departureDate,
        //     departureTime: ridePayload.departureTime,
        //   },
        // });
        notifiedCount++;
      } catch { /* ignore */ }
    }
  }

  return notifiedCount;
}