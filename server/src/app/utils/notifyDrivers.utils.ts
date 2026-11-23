// utils/notifyDrivers.utils.ts
import { Types } from 'mongoose';
import { User } from '../modules/user/user.model';
import { USER_STATUS } from '../modules/user/user.constant';
import { ILatLng } from '../socket/interface/ride';
import { Ride } from '../modules/ride/ride.model';
import { Passenger } from '../modules/passenger/passenger.model';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { hasDriverRideAtDateTime } from './geo.utils';
import { Vehicle } from '../modules/vehicle/vehicle.model';
import { isVehicleType } from './luggage.utils';
import { modeType } from '../modules/notification/notification.interface';
import { notifyUserPush } from './notifyUser.utils';
import { calculateDistance } from './location.utils';
import { resolveUserLanguage, translateText } from '../i18n/i18n';
import { getDriverLiveState } from './driverAvailability.utils';
import { getRedisClient } from '../config/redis.config';

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
    // B-07: per passenger, so a second rider joining a split ride still pushes.
    dedupeKey: `new-ride:${rideId}:${String(ridePayload?._id || '')}`,
    data: {
      type: 'NEW_RIDE_REQUEST',
      rideId: String(rideId),
      passengerId: String(ridePayload?._id || ''),
      bookingId: String(ridePayload?.bookingId || ''),
      rideType,
      screen: 'ride_request',
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
 *
 * Variants:
 *  - matching:      first dispatch after payment / split match.
 *  - rematch:       no-driver job re-notify. Push once per `rematchStage`
 *                   ('initial' | 'final') and again whenever the count grows,
 *                   so the rider hears at rematch time without a push every
 *                   few minutes. Socket is emitted on every run.
 *  - solo_fallback: split → Solo conversion.
 */
export async function notifyRiderDriversNotified(input: {
  io: any;
  userId: string;
  rideId: string;
  passengerId: string;
  bookingId?: string;
  newlyNotified: number;
  variant?: 'matching' | 'rematch' | 'solo_fallback';
  rematchStage?: 'initial' | 'final';
}): Promise<number> {
  const {
    io,
    userId,
    rideId,
    passengerId,
    bookingId,
    newlyNotified,
    variant = 'matching',
    rematchStage = 'initial',
  } = input;
  if (!userId || !rideId) return newlyNotified;

  // B-11: a rider who cancelled (or was cancelled) while a matching/rematch run
  // was in flight used to get "Still Searching for a Driver" afterwards. Only
  // riders who are still waiting for a driver get this update.
  if (passengerId) {
    try {
      const waiting = await Passenger.exists({
        _id: passengerId,
        status: { $in: [PASSENGER_STATUS.pending, PASSENGER_STATUS.split_matching] },
      });
      if (!waiting) return 0;
    } catch {
      /* fall through: never block the update on a lookup error */
    }
  }

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
  const isRematch = variant === 'rematch';
  const found = total > 0;
  const title = isSolo
    ? 'Converted to Solo Ride'
    : isRematch
      ? 'Still Searching for a Driver'
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
      phase: variant,
      matchedVia: isSolo ? 'solo_fallback' : undefined,
      title: translateText(title, lang),
      message: translateText(description, lang),
    });
  } catch {
    /* socket may not be initialized */
  }

  // Issue 9: a few seconds after "Drivers Notified – 3 nearby drivers…" the
  // no-driver cron used to push "Still Searching – 3 nearby drivers…" again
  // (same count, new stage). A re-match push now goes out only when MORE
  // drivers have been reached than the rider was last told about.
  const pushedCountKey = `drivers-notified:pushed-count:${rideId}`;
  let lastPushedCount = 0;
  try {
    lastPushedCount = Number((await getRedisClient().get(pushedCountKey)) || 0);
  } catch {
    /* ignore */
  }
  if (isRematch && total <= lastPushedCount) {
    return total; // socket update above is enough
  }

  // matching / solo: one push per ride + outcome ("searching" → later "found"
  // still gets through; retries with the same outcome do not).
  // rematch: one push per stage + driver count.
  const dedupeKey = isRematch
    ? `drivers-notified:rematch:${rideId}:${rematchStage}:${total}`
    : `drivers-notified:${variant}:${rideId}:${found ? 'found' : 'none'}`;

  await notifyUserPush({
    userId,
    message: title,
    description,
    reference: String(rideId),
    modelType: isSolo ? modeType.Passenger : modeType.Ride,
    dedupeKey,
    dedupeTtlSeconds: isRematch ? 48 * 60 * 60 : undefined,
    data: {
      type: isSolo
        ? 'SPLIT_TO_SOLO'
        : isRematch
          ? 'RIDE_RE_MATCHING'
          : 'DRIVERS_NOTIFIED',
      rideId: String(rideId),
      passengerId: String(passengerId),
      notifiedDrivers: total,
    },
  });

  try {
    if (total > lastPushedCount) {
      await getRedisClient().set(pushedCountKey, String(total), 'EX', 48 * 60 * 60);
    }
  } catch {
    /* ignore */
  }

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

/**
 * Issue 4: drivers were notified strictly one after another (≈5 DB calls + an
 * FCM round trip each), so drivers late in the list, and the rider's "drivers
 * notified" push, waited for everyone before them. Each driver's claim
 * (markDriverNotifiedOnce) is an atomic Mongo update, so parallel runs are safe.
 */
export const DRIVER_NOTIFY_CONCURRENCY = 5;

export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      try {
        await worker(item);
      } catch (error) {
        console.error('driver notify failed:', error);
      }
    }
  });
  await Promise.all(lanes);
}

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

/**
 * True only when the driver is live right now (see driverAvailability.utils)
 * and their last known point is inside the pickup radius. Saved profile
 * locations and stale Redis GEO members are ignored, so a city full of old
 * test accounts is not reported as "28 drivers notified" (issue 42), while a
 * parked driver with the app open is still reached (issues 61 / 63).
 */
export async function isFreshAndWithinRadius(
  redis: any,
  driverId: string,
  pickup: ILatLng,
  radiusKm: number,
  io?: any,
): Promise<boolean> {
  const { location } = await getDriverLiveState(redis, driverId, io);
  if (!location) return false;
  return calculateDistance(location, pickup) <= radiusKm;
}

async function collectFreshDriversWithinRadius(
  redis: any,
  pickup: ILatLng,
  radiusKm: number,
  io?: any,
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
    if (await isFreshAndWithinRadius(redis, driverId, pickup, radiusKm, io)) {
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
    io,
  );

  if (targetDriverIds?.length) {
    for (const tid of targetDriverIds) {
      if (await isFreshAndWithinRadius(redis, String(tid), pickup, radiusKm, io)) {
        candidateDriverIds.add(String(tid));
      }
    }
  }

  const attemptNotify = async (driverIds: Iterable<string>) => {
    await runWithConcurrency([...driverIds], DRIVER_NOTIFY_CONCURRENCY, async (driverId) => {
      if (notifiedIds.includes(driverId)) return;
      if (privateDriverIds && !privateDriverIds.has(driverId)) return;

      const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
      if (rejected) return;

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
        return;
      }

      const availability = await hasDriverRideAtDateTime(
        driverId,
        departureDate,
        departureTime,
        rideType,
        requestedSeats
      );
      if (!availability.available) return;

      const shouldNotify = await markDriverNotifiedOnce(rideId, driverId);
      if (!shouldNotify) return;

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
    });
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
    io,
  );

  await runWithConcurrency([...candidateDriverIds], DRIVER_NOTIFY_CONCURRENCY, async (driverId) => {
    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) return;

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
      return;
    }

    const availability = await hasDriverRideAtDateTime(
      driverId,
      departureDate,
      departureTime,
      'split',
      requestedSeats
    );
    if (!availability.available) return;

    const location = await getDriverCurrentLocation(redis, driverId, dbDriver);
    if (location && !isNearRoute(location.lat, location.lng)) return;

    // B-07: dedupe per passenger, not per ride. The old per-ride check skipped
    // every driver who already had passenger A's card, so passenger B's
    // request (a second card on the same split ride) never reached them.
    const shouldNotify = passengerId
      ? await markDriverNotifiedForPassengerOnce(redis, rideId, passengerId, driverId)
      : await markDriverNotifiedOnce(rideId, driverId);
    if (!shouldNotify) return;

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
  });

  // B-07: drivers who already received this split ride (for an earlier
  // passenger) must also get the new passenger's request, even if they are no
  // longer inside the live radius right now.
  if (passengerId) {
    const ride = await Ride.findById(rideId).select('notifiedDriverIds driverId').lean();
    const previous = new Set<string>(
      ((ride as any)?.notifiedDriverIds || []).map((id: any) => String(id)),
    );
    if ((ride as any)?.driverId) previous.add(String((ride as any).driverId));

    for (const driverId of previous) {
      if (notifiedIds.includes(driverId)) continue;
      try {
        if (await redis.sismember(`ride:rejected:${rideId}`, driverId)) continue;
        if (!(await markDriverNotifiedForPassengerOnce(redis, rideId, passengerId, driverId))) {
          continue;
        }
        const sent = await emitNewRideRequestToDriver(io, redis, driverId, rideId, ridePayload);
        if (sent) {
          notifiedIds.push(driverId);
          notifiedCount++;
        }
      } catch (err: any) {
        console.warn(`Split re-notify failed for driver ${driverId}:`, err?.message || err);
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

/** Atomic per-(ride, passenger, driver) dedupe; true the first time only. */
async function markDriverNotifiedForPassengerOnce(
  redis: any,
  rideId: string,
  passengerId: string,
  driverId: string,
): Promise<boolean> {
  if (!Types.ObjectId.isValid(driverId) || !Types.ObjectId.isValid(rideId)) return false;
  const key = `ride:notified:${rideId}:passenger:${passengerId}`;
  const added = await redis.sadd(key, driverId);
  await redis.expire(key, 7 * 24 * 60 * 60);
  return Number(added) === 1;
}
