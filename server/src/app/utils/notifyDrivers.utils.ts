// utils/notifyDrivers.utils.ts
import { Types } from 'mongoose';
import { User } from '../modules/user/user.model';
import { USER_STATUS } from '../modules/user/user.constant';
import { ILatLng } from '../socket/interface/ride';
import { Ride } from '../modules/ride/ride.model';
import { hasDriverRideAtDateTime } from './geo.utils';
import { Vehicle } from '../modules/vehicle/vehicle.model';
import { isVehicleType } from './luggage.utils';
import { modeType } from '../modules/notification/notification.interface';
import { notifyUserPush } from './notifyUser.utils';
import { calculateDistance } from './location.utils';
import { resolveUserLanguage, translateText } from '../i18n/i18n';

/** Location ping older than this is not "nearby right now". */
const FRESH_LOCATION_MS = 45 * 60 * 1000;

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

  // One emit. The driver socket is in both rooms; two emits would deliver the event twice.
  if (driver.isOnline) {
    try {
      await redis.sadd('users:online', driverId);
    } catch {
      /* ignore redis error */
    }

    io.to(`driver:${driverId}`)
      .to(`user:${driverId}`)
      .emit('ride:new-request', ridePayload);
  }

  const rideType = String(ridePayload?.rideType || '');
  const rawDescription =
    rideType === 'split'
      ? 'A new split ride request is available.'
      : 'A new private ride request is available.';

  await notifyUserPush({
    userId: driverId,
    message: 'New Ride Request',
    description: rawDescription,
    reference: rideId,
    modelType: modeType.Ride,
    dedupeKey: `new-ride:${rideId}`,
    data: {
      type: 'NEW_RIDE_REQUEST',
      rideId: String(rideId),
      passengerId: String(ridePayload?._id || ''),
      rideType,
    },
  });

  return true;
}

const nearbyDriversSentence = (count: number): string =>
  `${count} nearby ${count === 1 ? 'driver has' : 'drivers have'} been notified.`;

/**
 * Tell the RIDER how many drivers have received their ride request
 * (socket `ride:drivers-notified` + one push / in-app row).
 *
 * The count is the cumulative distinct drivers on `ride.notifiedDriverIds`
 * (plus an assigned driver), not just the ones newly reached by this call.
 * Otherwise a retried payment confirm, or a second split passenger joining a
 * ride whose drivers were already notified, would tell the rider "0 drivers".
 *
 * Must be called AFTER the driver-notify step for the ride.
 */
export async function notifyRiderDriversNotified(input: {
  io: any;
  userId: string;
  rideId: string;
  passengerId: string;
  bookingId?: string;
  newlyNotified: number;
  variant?: 'matching' | 'solo_fallback';
}): Promise<number> {
  const {
    io,
    userId,
    rideId,
    passengerId,
    bookingId,
    newlyNotified,
    variant = 'matching',
  } = input;
  if (!userId || !rideId) return newlyNotified;

  let total = newlyNotified;
  try {
    const ride = await Ride.findById(rideId)
      .select('notifiedDriverIds driverId')
      .lean();
    const ids = new Set<string>(
      ((ride as any)?.notifiedDriverIds || []).map((id: any) => String(id)),
    );
    if ((ride as any)?.driverId) ids.add(String((ride as any).driverId));
    total = Math.max(newlyNotified, ids.size);
  } catch {
    /* fall back to newlyNotified */
  }

  const isSolo = variant === 'solo_fallback';
  const found = total > 0;
  const title = isSolo
    ? 'Converted to Solo Ride'
    : found
      ? 'Drivers Notified'
      : 'Searching for Drivers';
  const description = isSolo
    ? found
      ? `No split match found. Your ride was released as Solo. ${nearbyDriversSentence(total)}`
      : 'No split match found. Your ride was released to drivers as a Solo trip.'
    : found
      ? `We're looking for a driver. ${nearbyDriversSentence(total)}`
      : 'We are still looking for a nearby driver.';

  try {
    const lang = await resolveUserLanguage(userId);
    io?.to(`user:${userId}`).emit('ride:drivers-notified', {
        rideId: String(rideId),
        passengerId: String(passengerId),
        bookingId: bookingId ? String(bookingId) : undefined,
        notifiedDrivers: total,
        newlyNotifiedDrivers: newlyNotified,
        matchedVia: isSolo ? 'solo_fallback' : undefined,
        title: translateText(title, lang),
        message: translateText(description, lang),
      });
  } catch {
    /* socket may not be initialized */
  }

  // One push per ride + outcome. "Searching" → later "found" still gets through;
  // retries with the same outcome do not.
  await notifyUserPush({
    userId,
    message: title,
    description,
    reference: String(rideId),
    modelType: isSolo ? modeType.Passenger : modeType.Ride,
    dedupeKey: `drivers-notified:${variant}:${rideId}:${found ? 'found' : 'none'}`,
    data: {
      type: isSolo ? 'SPLIT_TO_SOLO' : 'DRIVERS_NOTIFIED',
      rideId: String(rideId),
      passengerId: String(passengerId),
      notifiedDrivers: total,
    },
  });

  return total;
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

function isUsablePoint(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/**
 * True only when the driver has a recent GPS point inside the pickup radius.
 * Saved profile locations and stale Redis GEO members are ignored, so a city
 * full of old test accounts is not reported as "28 drivers notified".
 */
async function isFreshAndWithinRadius(
  redis: any,
  driverId: string,
  pickup: ILatLng,
  radiusKm: number,
): Promise<boolean> {
  let lat: number | null = null;
  let lng: number | null = null;
  let fresh = false;

  try {
    const currentRaw = await redis.get(`driver:${driverId}:current`);
    if (currentRaw) {
      const parsed = JSON.parse(currentRaw);
      const currentLat = Number(parsed?.lat);
      const currentLng = Number(parsed?.lng);
      if (isUsablePoint(currentLat, currentLng)) {
        lat = currentLat;
        lng = currentLng;
        fresh = true;
      }
    }
  } catch {
    /* ignore */
  }

  if (!fresh) {
    try {
      const hash = await redis.hgetall(`driver:${driverId}:details`);
      const updatedAt = Number(hash?.lastUpdate || 0);
      const savedLat = Number(hash?.lastLat);
      const savedLng = Number(hash?.lastLng);
      if (
        isUsablePoint(savedLat, savedLng) &&
        updatedAt > 0 &&
        Date.now() - updatedAt <= FRESH_LOCATION_MS
      ) {
        lat = savedLat;
        lng = savedLng;
        fresh = true;
      }
    } catch {
      /* ignore */
    }
  }

  if (!fresh || lat == null || lng == null) return false;
  return calculateDistance({ lat, lng }, pickup) <= radiusKm;
}

async function collectFreshDriversWithinRadius(
  redis: any,
  pickup: ILatLng,
  radiusKm: number,
): Promise<Set<string>> {
  const candidates = new Set<string>();

  try {
    const geo = (await redis.georadius(
      'drivers:location',
      pickup.lng,
      pickup.lat,
      radiusKm,
      'km',
    )) as string[];
    for (const id of geo || []) candidates.add(String(id));
  } catch {
    /* ignore geo error */
  }

  try {
    const online = (await redis.smembers('users:online')) as string[];
    for (const id of online || []) candidates.add(String(id));
  } catch {
    /* ignore */
  }

  const nearby = new Set<string>();
  for (const driverId of candidates) {
    if (await isFreshAndWithinRadius(redis, driverId, pickup, radiusKm)) {
      nearby.add(driverId);
    }
  }
  return nearby;
}

async function markDriverNotifiedOnce(
  rideId: string,
  driverId: string
): Promise<boolean> {
  if (!Types.ObjectId.isValid(driverId) || !Types.ObjectId.isValid(rideId)) {
    return false;
  }
  const driverObjectId = new Types.ObjectId(driverId);
  const updatedRide = await Ride.findOneAndUpdate(
    { _id: rideId, notifiedDriverIds: { $ne: driverObjectId } },
    { $addToSet: { notifiedDriverIds: driverObjectId } },
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
  const candidateDriverIds = await collectFreshDriversWithinRadius(
    redis,
    pickup,
    radiusKm,
  );

  if (targetDriverIds?.length) {
    for (const tid of targetDriverIds) {
      if (await isFreshAndWithinRadius(redis, String(tid), pickup, radiusKm)) {
        candidateDriverIds.add(String(tid));
      }
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

  // Every fresh driver inside the pickup radius. A selected id must not
  // block the drivers who are actually nearby.
  await attemptNotify(candidateDriverIds);

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

  const candidateDriverIds = await collectFreshDriversWithinRadius(
    redis,
    pickup,
    10,
  );

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
