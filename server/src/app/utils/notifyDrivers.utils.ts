// utils/notifyDrivers.utils.ts
import { User } from '../modules/user/user.model';
import { USER_ROLE, USER_STATUS } from '../modules/user/user.constant';
import { ILatLng } from '../socket/interface/ride';
import { Ride } from '../modules/ride/ride.model';
import { hasDriverRideAtDateTime } from './geo.utils';
import { Vehicle } from '../modules/vehicle/vehicle.model';
import { isVehicleType } from './luggage.utils';
import { sendNotification } from './sentPushNotification';
import { modeType } from '../modules/notification/notification.interface';
import { Notification } from '../modules/notification/notification.model';
import { normalizeLanguage, translateText } from '../i18n/i18n';

/** Socket (if online) + in-app notification + FCM push for a new ride request (both online & offline drivers). */
export async function emitNewRideRequestToDriver(
  io: any,
  redis: any,
  driverId: string,
  rideId: string,
  ridePayload: any,
): Promise<boolean> {
  const driver = await User.findById(driverId)
    .select('fcmToken isOnline isDeleted status isKycVerified language')
    .lean();

  if (
    !driver ||
    driver.isDeleted ||
    driver.status !== USER_STATUS.active ||
    !driver.isKycVerified
  ) {
    return false;
  }

  // Socket notification if driver is currently online
  if (driver.isOnline) {
    try {
      await redis.sadd('users:online', driverId);
    } catch {
      /* ignore redis error */
    }

    io.to(`driver:${driverId}`).emit('ride:new-request', ridePayload);
    io.to(`user:${driverId}`).emit('ride:new-request', ridePayload);
  }

  const driverLang = normalizeLanguage(driver.language);
  const rideType = String(ridePayload?.rideType || '');
  const rawDescription =
    rideType === 'split'
      ? 'A new split ride request is available.'
      : 'A new private ride request is available.';

  const notificationPayload = {
    receiver: driverId,
    message: translateText('New Ride Request', driverLang),
    description: translateText(rawDescription, driverLang),
    language: driverLang,
    reference: rideId,
    modelType: modeType.Ride,
    data: {
      type: 'NEW_RIDE_REQUEST',
      rideId: String(rideId),
      passengerId: String(ridePayload?._id || ''),
      rideType,
    },
  };

  const persistInApp = async () => {
    await Notification.create({
      receiver: driverId,
      message: notificationPayload.message,
      description: notificationPayload.description,
      reference: rideId,
      modelType: modeType.Ride,
    });
  };

  try {
    let persisted = false;

    if (driver?.fcmToken) {
      const response = await sendNotification(
        [driver.fcmToken],
        notificationPayload,
      );
      persisted = !!(response && (response as any).successCount > 0);
    }

    if (!persisted) {
      await persistInApp();
    }
  } catch (error) {
    console.error(`Notify new-ride-request failed for driver ${driverId}:`, error);
    try {
      await persistInApp();
    } catch {
      /* ignore fallback errors */
    }
  }

  return true;
}

/** Private rides: drivers whose active vehicle can accommodate the requested vehicleType. */
async function privateMatchingDriverIds(
  ridePayload: any,
): Promise<Set<string> | null> {
  if (ridePayload?.rideType !== 'private') return null;
  if (!isVehicleType(ridePayload.vehicleType)) return null;

  const minSeats = ridePayload.vehicleType === '6-seater' ? 6 : 4;
  const vehicles = await Vehicle.find({
    isDeleted: { $ne: true },
    seats: { $gte: minSeats },
  })
    .select('userId')
    .lean();

  return new Set(vehicles.map((vehicle) => String(vehicle.userId)));
}

const CORRIDOR_RADIUS_METERS = 10000;

function pointToSegmentMeters(
  pLat: number,
  pLng: number,
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dx = (bLng - aLng) * Math.cos(toRad((aLat + bLat) / 2));
  const dy = bLat - aLat;
  const denom = dx * dx + dy * dy || 1;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((pLng - aLng) * Math.cos(toRad((aLat + bLat) / 2)) * dx +
        (pLat - aLat) * dy) /
        denom
    )
  );
  const closestLat = aLat + t * (bLat - aLat);
  const closestLng = aLng + t * (bLng - aLng);
  const R = 6378100;
  const dL = ((closestLat - pLat) * Math.PI) / 180;
  const dG = ((closestLng - pLng) * Math.PI) / 180;
  const a =
    Math.sin(dL / 2) ** 2 +
    Math.cos((pLat * Math.PI) / 180) *
      Math.cos((closestLat * Math.PI) / 180) *
      Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getDriverCurrentLocation(
  redis: any,
  driverId: string,
  dbDriver?: any
): Promise<{ lat: number; lng: number } | null> {
  try {
    const raw = await redis.get(`driver:${driverId}:current`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.lat && parsed?.lng)
        return { lat: parsed.lat, lng: parsed.lng };
    }
  } catch {
    /* ignore */
  }

  try {
    const hash = await redis.hgetall(`driver:${driverId}:details`);
    if (hash?.lastLat && hash?.lastLng) {
      const lat = parseFloat(hash.lastLat);
      const lng = parseFloat(hash.lastLng);
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0)
        return { lat, lng };
    }
  } catch {
    /* ignore */
  }

  if (dbDriver) {
    const coords = dbDriver?.location?.coordinates;
    if (coords && Array.isArray(coords) && coords.length === 2) {
      const lng = coords[0];
      const lat = coords[1];
      if (lat !== 0 || lng !== 0) return { lat, lng };
    }
  }

  return null;
}

async function markDriverNotifiedOnce(
  rideId: string,
  driverId: string
): Promise<boolean> {
  const updatedRide = await Ride.findOneAndUpdate(
    { _id: rideId, notifiedDriverIds: { $ne: driverId } },
    { $addToSet: { notifiedDriverIds: driverId } },
    { returnDocument: 'before' }
  )
    .select('_id')
    .lean();

  return !!updatedRide;
}

// ── Notify nearby drivers (private / solo ride — online & offline within geo-radius) ──
export async function notifyNearbyDrivers(
  rideId: string,
  pickup: ILatLng,
  ridePayload: any,
  redis: any,
  io: any,
  passengerId?: string,
  radiusKm = 10,
  targetDriverIds?: string[],
  _options?: { notifyMode?: 'nearby' | 'all_eligible' }
): Promise<number> {
  let notifiedCount = 0;
  const notifiedIds: string[] = [];

  const departureDate = ridePayload.departureDate as string;
  const departureTime = ridePayload.departureTime as string;
  const rideType = ridePayload.rideType as string;
  const requestedSeats = (ridePayload.requestedSeats as number) || 1;
  const privateDriverIds = await privateMatchingDriverIds(ridePayload);

  type GeoResult = Array<[string, string]>;
  let redisOnlineDrivers: GeoResult = [];
  try {
    redisOnlineDrivers = (await redis.georadius(
      'drivers:location',
      pickup.lng,
      pickup.lat,
      radiusKm,
      'km',
      'WITHDIST'
    )) as GeoResult;
  } catch {
    redisOnlineDrivers = [];
  }

  const candidateDriverIds = new Set<string>(
    redisOnlineDrivers.map(([id]) => String(id))
  );

  // Include nearby drivers from DB within radiusKm (both online and offline drivers satisfying geo-radius condition)
  try {
    const dbNearby = await User.find({
      role: USER_ROLE.provider,
      isDeleted: false,
      status: USER_STATUS.active,
      isKycVerified: true,
      location: {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [pickup.lng, pickup.lat] },
          $maxDistance: radiusKm * 1000,
        },
      },
    })
      .select('_id location isOnline')
      .lean();

    for (const d of dbNearby) {
      const id = d._id.toString();
      candidateDriverIds.add(id);
      if (d.isOnline) {
        const coords = d.location?.coordinates;
        if (coords && coords.length === 2 && (coords[0] !== 0 || coords[1] !== 0)) {
          await redis
            .geoadd('drivers:location', coords[0], coords[1], id)
            .catch(() => {});
        }
      }
    }
  } catch {
    /* ignore geo query error */
  }

  if (targetDriverIds?.length) {
    for (const tid of targetDriverIds) {
      candidateDriverIds.add(String(tid));
    }
  }

  const attemptNotify = async (driverIds: Iterable<string>) => {
    for (const driverId of driverIds) {
      if (notifiedIds.includes(driverId)) continue;
      if (privateDriverIds && !privateDriverIds.has(driverId)) continue;

      const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
      if (rejected) continue;

      const driverDoc = await User.findById(driverId)
        .select('isKycVerified isOnline isDeleted status _id')
        .lean();

      // Must be valid active KYC-verified driver (online OR offline within geo-radius)
      if (
        !driverDoc ||
        driverDoc.isDeleted ||
        driverDoc.status !== USER_STATUS.active ||
        !driverDoc.isKycVerified
      ) {
        continue;
      }

      const availability = await hasDriverRideAtDateTime(
        driverId,
        departureDate,
        departureTime,
        rideType,
        requestedSeats
      );
      if (!availability.available) continue;

      const shouldNotify = await markDriverNotifiedOnce(rideId, driverId);
      if (!shouldNotify) continue;

      const sent = await emitNewRideRequestToDriver(
        io,
        redis,
        driverId,
        rideId,
        ridePayload
      );
      if (sent) {
        notifiedIds.push(driverId);
        notifiedCount++;
      }
    }
  };

  // If specific target drivers requested, try them first
  if (targetDriverIds?.length) {
    await attemptNotify(targetDriverIds.map(String));
  }

  // If no target driver was notified (e.g. offline/busy) or no target specified, notify candidate drivers
  if (notifiedCount === 0) {
    await attemptNotify(candidateDriverIds);
  }

  if (notifiedIds.length) {
    await Ride.findByIdAndUpdate(rideId, {
      $addToSet: { notifiedDriverIds: { $each: notifiedIds } },
    });
  }

  return notifiedCount;
}

// ── Notify nearby drivers (split ride — online & offline within route corridor) ──────────────
export async function notifyNearbyDriversForSplitRide(
  rideId: string,
  routeGeometry: { type: string; coordinates: number[][] } | null,
  pickup: { lat: number; lng: number },
  ridePayload: any,
  redis: any,
  io: any,
  passengerId?: string
): Promise<number> {
  let notifiedCount = 0;
  const notifiedIds: string[] = [];

  const departureDate = ridePayload.departureDate as string;
  const departureTime = ridePayload.departureTime as string;
  const requestedSeats = (ridePayload.requestedSeats as number) || 1;

  const isNearRoute = (lat: number, lng: number): boolean => {
    if (!routeGeometry?.coordinates?.length) return true;
    for (let i = 0; i < routeGeometry.coordinates.length - 1; i++) {
      const [lng1, lat1] = routeGeometry.coordinates[i];
      const [lng2, lat2] = routeGeometry.coordinates[i + 1];
      if (
        pointToSegmentMeters(lat, lng, lat1, lng1, lat2, lng2) <=
        CORRIDOR_RADIUS_METERS
      )
        return true;
    }
    return false;
  };

  type GeoResult = Array<[string, string]>;
  let redisOnlineDrivers: GeoResult = [];
  try {
    redisOnlineDrivers = (await redis.georadius(
      'drivers:location',
      pickup.lng,
      pickup.lat,
      15,
      'km',
      'WITHDIST'
    )) as GeoResult;
  } catch {
    redisOnlineDrivers = [];
  }

  const candidateDriverIds = new Set<string>(
    redisOnlineDrivers.map(([id]) => String(id))
  );

  // Include nearby drivers from DB within 15km (both online and offline drivers satisfying geo-radius condition)
  try {
    const dbNearby = await User.find({
      role: USER_ROLE.provider,
      isDeleted: false,
      status: USER_STATUS.active,
      isKycVerified: true,
      location: {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [pickup.lng, pickup.lat] },
          $maxDistance: 15000,
        },
      },
    })
      .select('_id location isOnline')
      .lean();

    for (const d of dbNearby) {
      const id = d._id.toString();
      candidateDriverIds.add(id);
      if (d.isOnline) {
        const coords = d.location?.coordinates;
        if (coords && coords.length === 2 && (coords[0] !== 0 || coords[1] !== 0)) {
          await redis
            .geoadd('drivers:location', coords[0], coords[1], id)
            .catch(() => {});
        }
      }
    }
  } catch {
    /* ignore geo query error */
  }

  for (const driverId of candidateDriverIds) {
    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    const dbDriver = await User.findById(driverId)
      .select('_id location isKycVerified isOnline isDeleted status')
      .lean();

    // Must be valid active KYC-verified driver (online OR offline within geo-radius/route)
    if (
      !dbDriver ||
      dbDriver.isDeleted ||
      dbDriver.status !== USER_STATUS.active ||
      !dbDriver.isKycVerified
    ) {
      continue;
    }

    const availability = await hasDriverRideAtDateTime(
      driverId,
      departureDate,
      departureTime,
      'split',
      requestedSeats
    );
    if (!availability.available) continue;

    const location = await getDriverCurrentLocation(redis, driverId, dbDriver);
    if (location && !isNearRoute(location.lat, location.lng)) continue;

    const shouldNotify = await markDriverNotifiedOnce(rideId, driverId);
    if (!shouldNotify) continue;

    const sent = await emitNewRideRequestToDriver(
      io,
      redis,
      driverId,
      rideId,
      ridePayload
    );
    if (sent) {
      notifiedIds.push(driverId);
      notifiedCount++;
    }
  }

  if (notifiedIds.length) {
    await Ride.findByIdAndUpdate(rideId, {
      $addToSet: { notifiedDriverIds: { $each: notifiedIds } },
    });
  }

  return notifiedCount;
}
