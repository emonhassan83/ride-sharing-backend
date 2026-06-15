// utils/notifyDrivers.utils.ts
import { User } from '../modules/user/user.model';
import { USER_ROLE, USER_STATUS } from '../modules/user/user.constant';
import { ILatLng } from '../socket/interface/ride';
import { Ride } from '../modules/ride/ride.model';
import { modeType } from '../modules/notification/notification.interface';
import { sendNotification } from './sentPushNotification';

const CORRIDOR_RADIUS_METERS = 10000;

// ── Point to segment distance (meters) ───────────────────────────────────────
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
  const closestLat = aLat + t * (bLat - aLat);
  const closestLng = aLng + t * (bLng - aLng);
  const R  = 6378100;
  const dL = ((closestLat - pLat) * Math.PI) / 180;
  const dG = ((closestLng - pLng) * Math.PI) / 180;
  const a  =
    Math.sin(dL / 2) ** 2 +
    Math.cos((pLat * Math.PI) / 180) *
    Math.cos((closestLat * Math.PI) / 180) *
    Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Get driver current location: Redis current → Redis hash → DB ──────────────
async function getDriverCurrentLocation(
  redis:    any,
  driverId: string,
  dbDriver?: any,
): Promise<{ lat: number; lng: number } | null> {

  // 1. Redis current key (live location, 5min TTL)
  try {
    const raw = await redis.get(`driver:${driverId}:current`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.lat && parsed?.lng) {
        return { lat: parsed.lat, lng: parsed.lng };
      }
    }
  } catch { /* ignore */ }

  // 2. Redis hash lastLat/lastLng (longer lived, updated on each location update)
  try {
    const hash = await redis.hgetall(`driver:${driverId}:details`);
    if (hash?.lastLat && hash?.lastLng) {
      const lat = parseFloat(hash.lastLat);
      const lng = parseFloat(hash.lastLng);
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        return { lat, lng };
      }
    }
  } catch { /* ignore */ }

  // 3. DB location (permanent last known — saved on go offline or cron sync)
  if (dbDriver) {
    const coords = dbDriver?.location?.coordinates;
    if (coords && Array.isArray(coords) && coords.length === 2) {
      const lng = coords[0];
      const lat = coords[1];
      if (lat !== 0 || lng !== 0) {
        return { lat, lng };
      }
    }
  }

  return null;
}

// ── Notify nearby drivers (private ride) ─────────────────────────────────────
export async function notifyNearbyDrivers(
  rideId:      string,
  pickup:      ILatLng,
  ridePayload: any,
  redis:       any,
  io:          any,
  passengerId: string,
  radiusKm     = 10,
): Promise<number> {
  let notifiedCount  = 0;
  const notifiedIds: string[] = [];

  type GeoResult = Array<[string, string]>;
  const onlineDrivers = (await redis.georadius(
    'drivers:location', pickup.lng, pickup.lat, radiusKm, 'km', 'WITHDIST',
  )) as GeoResult;

  const onlineDriverIds = new Set(onlineDrivers.map(([id]) => id));

  // ── Online drivers — socket + FCM ─────────────────────────────────────────
  for (const [driverId] of onlineDrivers) {
    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    io.to(`driver:${driverId}`).emit('ride:new-request', ridePayload);
    notifiedIds.push(driverId);
    notifiedCount++;

    // FCM for online drivers (background/killed app state)
    const driver = await User.findById(driverId).select('_id fcmToken').lean();
    if (driver?.fcmToken) {
      sendNotification([(driver as any).fcmToken], {
        receiver:    driver._id,
        message:     'New Ride Request!',
        description: `New ${ridePayload.rideType} ride from ${ridePayload.pickup?.address || 'nearby'}`,
        reference:   passengerId,
        modelType:   modeType.Passenger,
      }).catch((err: any) => console.warn(`FCM failed for online driver ${driverId}:`, err));
    }
  }

  // ── Offline drivers — DB location + FCM ──────────────────────────────────
  const offlineDrivers = await User.find({
    role:      USER_ROLE.provider,
    isDeleted: false,
    status:    USER_STATUS.active,
    location: {
      $nearSphere: {
        $geometry:    { type: 'Point', coordinates: [pickup.lng, pickup.lat] },
        $maxDistance: radiusKm * 1000,
      },
    },
  }).select('_id fcmToken location').lean();

  for (const driver of offlineDrivers) {
    const driverId = driver._id.toString();
    if (onlineDriverIds.has(driverId)) continue;

    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    notifiedIds.push(driverId);

    const fcmToken = (driver as any).fcmToken;
    if (fcmToken) {
      try {
        await sendNotification([fcmToken], {
          receiver:    driver._id,
          message:     'New Ride Request!',
          description: `New ${ridePayload.rideType} ride from ${ridePayload.pickup?.address || 'nearby'}`,
          reference:   passengerId,
          modelType:   modeType.Passenger,
        });
        notifiedCount++;
      } catch (err) {
        console.warn(`FCM failed for offline driver ${driverId}:`, err);
      }
    }
  }

  // Save notified driver IDs to ride
  if (notifiedIds.length) {
    await Ride.findByIdAndUpdate(rideId, {
      $addToSet: { notifiedDriverIds: { $each: notifiedIds } },
    });
  }

  return notifiedCount;
}

// ── Notify nearby drivers (split ride — route corridor) ───────────────────────
export async function notifyNearbyDriversForSplitRide(
  rideId:        string,
  routeGeometry: { type: string; coordinates: number[][] } | null,
  pickup:        { lat: number; lng: number },
  ridePayload:   any,
  redis:         any,
  io:            any,
  passengerId?:  string,
): Promise<number> {
  let notifiedCount  = 0;
  const notifiedIds: string[] = [];

  const isNearRoute = (lat: number, lng: number): boolean => {
    if (!routeGeometry?.coordinates?.length) return true;
    for (let i = 0; i < routeGeometry.coordinates.length - 1; i++) {
      const [lng1, lat1] = routeGeometry.coordinates[i];
      const [lng2, lat2] = routeGeometry.coordinates[i + 1];
      if (pointToSegmentMeters(lat, lng, lat1, lng1, lat2, lng2) <= CORRIDOR_RADIUS_METERS)
        return true;
    }
    return false;
  };

  type GeoResult = Array<[string, string]>;
  const onlineDrivers = (await redis.georadius(
    'drivers:location', pickup.lng, pickup.lat, 15, 'km', 'WITHDIST',
  )) as GeoResult;

  const onlineDriverIds = new Set(onlineDrivers.map(([id]) => id));

  // ── Online drivers — route check + socket + FCM ───────────────────────────
  for (const [driverId] of onlineDrivers) {
    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    // Fetch DB driver for location fallback
    const dbDriver = await User.findById(driverId)
      .select('_id fcmToken location')
      .lean();

    // Route corridor check: Redis → DB fallback
    const location = await getDriverCurrentLocation(redis, driverId, dbDriver);
    if (location && !isNearRoute(location.lat, location.lng)) continue;

    io.to(`driver:${driverId}`).emit('ride:new-request', ridePayload);
    notifiedIds.push(driverId);
    notifiedCount++;

    // FCM for online drivers too
    if (dbDriver?.fcmToken) {
      sendNotification([(dbDriver as any).fcmToken], {
        receiver:    dbDriver._id,
        message:     'New Split Ride Request!',
        description: `Split ride from ${ridePayload.pickup?.address || 'nearby'}`,
        reference:   passengerId || ridePayload.passengerId,
        modelType:   modeType.Passenger,
      }).catch((err: any) => console.warn(`FCM failed for online split driver ${driverId}:`, err));
    }
  }

  // ── Offline drivers — route check + FCM ──────────────────────────────────
  const offlineDrivers = await User.find({
    role:      USER_ROLE.provider,
    isDeleted: false,
    status:    USER_STATUS.active,
    location: {
      $nearSphere: {
        $geometry:    { type: 'Point', coordinates: [pickup.lng, pickup.lat] },
        $maxDistance: 15000,
      },
    },
  }).select('_id fcmToken location').lean();

  for (const driver of offlineDrivers) {
    const driverId = driver._id.toString();
    if (onlineDriverIds.has(driverId)) continue;

    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    // Route corridor check using DB location
    const location = await getDriverCurrentLocation(redis, driverId, driver);
    if (location && !isNearRoute(location.lat, location.lng)) continue;

    notifiedIds.push(driverId);

    const fcmToken = (driver as any).fcmToken;
    if (fcmToken) {
      try {
        await sendNotification([fcmToken], {
          receiver:    driver._id,
          message:     'New Split Ride Request!',
          description: `Split ride from ${ridePayload.pickup?.address || 'nearby'}`,
          reference:   passengerId || ridePayload.passengerId,
          modelType:   modeType.Passenger,
        });
        notifiedCount++;
      } catch (err) {
        console.warn(`FCM failed for offline split driver ${driverId}:`, err);
      }
    }
  }

  if (notifiedIds.length) {
    await Ride.findByIdAndUpdate(rideId, {
      $addToSet: { notifiedDriverIds: { $each: notifiedIds } },
    });
  }

  return notifiedCount;
}