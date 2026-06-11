// utils/notifyDrivers.utils.ts
import { User } from '../modules/user/user.model';
import { USER_ROLE, USER_STATUS } from '../modules/user/user.constant';

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