// utils/notifyDrivers.utils.ts
import { User } from '../modules/user/user.model';
import { USER_ROLE, USER_STATUS } from '../modules/user/user.constant';

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

// ── Notify nearby drivers (private ride) ─────────────────────────────────────
export async function notifyNearbyDrivers(
  rideId:      string,
  pickup:      { lat: number; lng: number },
  ridePayload: any,
  redis:       any,
  io:          any,
  radiusKm     = 10,
): Promise<number> {
  let notifiedCount  = 0;
  const notifiedIds: string[] = [];

  type GeoResult = Array<[string, string]>;
  const onlineDrivers = (await redis.georadius(
    'drivers:location', pickup.lng, pickup.lat, radiusKm, 'km', 'WITHDIST',
  )) as GeoResult;

  const onlineDriverIds = new Set(onlineDrivers.map(([id]) => id));

  // Online — socket
  for (const [driverId] of onlineDrivers) {
    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;
    io.to(`driver:${driverId}`).emit('ride:new-request', ridePayload);
    notifiedIds.push(driverId);
    notifiedCount++;
  }

  // Offline — FCM + DB location
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
  }).select('_id fcmToken').lean();

  for (const driver of offlineDrivers) {
    const driverId = driver._id.toString();
    if (onlineDriverIds.has(driverId)) continue;

    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    notifiedIds.push(driverId);

    if (driver.fcmToken) {
      // try {
      //   await sendPushNotification({
      //     fcmToken: driver.fcmToken,
      //     title:    'New Ride Request!',
      //     body:     `${ridePayload.rideType} ride from ${ridePayload.pickup?.address || 'nearby'}`,
      //     data: {
      //       type:          'RIDE_REQUEST',
      //       rideId,
      //       passengerId:   ridePayload.passengerId,
      //       estimatedFare: String(ridePayload.estimatedFare),
      //       departureDate: ridePayload.departureDate,
      //       departureTime: ridePayload.departureTime,
      //     },
      //   });
      //   notifiedCount++;
      // } catch (err) {
      //   console.warn(`FCM failed for driver ${driverId}:`, err);
      // }
    }
  }

  // ✅ Save notified driver IDs to ride
  if (notifiedIds.length) {
    const { Ride } = await import('../modules/ride/ride.model');
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
): Promise<number> {
  let notifiedCount = 0;

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

  for (const [driverId] of onlineDrivers) {
    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    try {
      const raw = await redis.get(`driver:${driverId}:current`);
      if (raw) {
        const { lat, lng } = JSON.parse(raw);
        if (!isNearRoute(lat, lng)) continue;
      }
    } catch { /* notify anyway */ }

    io.to(`driver:${driverId}`).emit('ride:new-request', ridePayload);
    notifiedCount++;
  }

  // Offline — FCM
  const offlineDrivers = await User.find({
    role:      USER_ROLE.provider,
    isDeleted: false,
    status:    USER_STATUS.active,
    fcmToken:  { $ne: null },
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

    const coords = (driver as any).location?.coordinates;
    if (coords && !isNearRoute(coords[1], coords[0])) continue;

    if ((driver as any).fcmToken) {
      // try {
      //   await sendPushNotification({
      //     fcmToken: (driver as any).fcmToken,
      //     title:    'New Split Ride Request!',
      //     body:     `Split ride from ${ridePayload.pickup?.address || 'nearby'}`,
      //     data: {
      //       type:          'SPLIT_RIDE_REQUEST',
      //       rideId,
      //       passengerId:   ridePayload.passengerId,
      //       estimatedFare: String(ridePayload.estimatedFare),
      //       departureDate: ridePayload.departureDate,
      //       departureTime: ridePayload.departureTime,
      //     },
      //   });
      //   notifiedCount++;
      // } catch { /* ignore */ }
    }
    
  }

  return notifiedCount;
}