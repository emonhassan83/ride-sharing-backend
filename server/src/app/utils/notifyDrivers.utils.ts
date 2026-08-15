// utils/notifyDrivers.utils.ts
import { User } from '../modules/user/user.model';
import { USER_ROLE, USER_STATUS } from '../modules/user/user.constant';
import { ILatLng } from '../socket/interface/ride';
import { Ride } from '../modules/ride/ride.model';
import { modeType } from '../modules/notification/notification.interface';
import { sendNotification } from './sentPushNotification';
import { hasDriverRideAtDateTime } from './geo.utils';

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
    { new: false }
  )
    .select('_id')
    .lean();

  return !!updatedRide;
}

// â”€â”€ Notify nearby drivers (private ride) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function notifyNearbyDrivers(
  rideId: string,
  pickup: ILatLng,
  ridePayload: any,
  redis: any,
  io: any,
  passengerId?: string,
  radiusKm = 10,
  targetDriverIds?: string[],
  options?: { notifyMode?: 'nearby' | 'all_eligible' }
): Promise<number> {
  let notifiedCount = 0;
  const notifiedIds: string[] = [];

  // â”€â”€ Required for availability check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const departureDate = ridePayload.departureDate as string;
  const departureTime = ridePayload.departureTime as string;
  const rideType = ridePayload.rideType as string;
  const requestedSeats = (ridePayload.requestedSeats as number) || 1;
  const notifyMode = options?.notifyMode || 'nearby';

  if (notifyMode === 'all_eligible') {
    const eligibleDrivers = await User.find({
      role: USER_ROLE.provider,
      isDeleted: false,
      status: USER_STATUS.active,
      isKycVerified: true,
      ...(targetDriverIds?.length ? { _id: { $in: targetDriverIds } } : {}),
    })
      .select('_id fcmToken')
      .lean();

    for (const driver of eligibleDrivers) {
      const driverId = driver._id.toString();
      const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
      if (rejected) continue;

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

      const isKnownOnline = await redis.sismember('users:online', driverId);
      if (isKnownOnline) {
        io.to(`driver:${driverId}`).emit('ride:new-request', ridePayload);
      }

      const fcmToken = (driver as any).fcmToken;
      if (fcmToken) {
        try {
          await sendNotification([fcmToken], {
            receiver: driver._id,
            message: 'New Ride Request!',
            description: `New ${rideType} scheduled ride from ${ridePayload.pickup?.address || 'nearby'}`,
            reference: passengerId,
            modelType: modeType.Passenger,
            data: {
              type: 'RIDE_REQUEST',
              rideId,
              passengerId: passengerId || '',
              bookingId: ridePayload.bookingId || '',
              rideType,
            },
          });
        } catch (err) {
          console.warn(`FCM failed for scheduled driver ${driverId}:`, err);
        }
      }

      notifiedIds.push(driverId);
      notifiedCount++;
    }

    if (notifiedIds.length) {
      await Ride.findByIdAndUpdate(rideId, {
        $addToSet: { notifiedDriverIds: { $each: notifiedIds } },
      });
    }

    return notifiedCount;
  }

  type GeoResult = Array<[string, string]>;
  const onlineDrivers = (await redis.georadius(
    'drivers:location',
    pickup.lng,
    pickup.lat,
    radiusKm,
    'km',
    'WITHDIST'
  )) as GeoResult;

  const onlineDriverIds = new Set(onlineDrivers.map(([id]) => id));

  // â”€â”€ Online drivers â€” availability check + socket + FCM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  for (const [driverId] of onlineDrivers) {
    if (targetDriverIds?.length && !targetDriverIds.includes(driverId)) continue;
    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    // KYC check for online drivers
    const driverDoc = await User.findById(driverId)
      .select('isKycVerified fcmToken _id')
      .lean();
    if (!driverDoc?.isKycVerified) continue;

    const availability = await hasDriverRideAtDateTime(
      driverId,
      departureDate,
      departureTime,
      rideType,
      requestedSeats
    );
    if (!availability.available) continue;

    io.to(`driver:${driverId}`).emit('ride:new-request', ridePayload);
    notifiedIds.push(driverId);
    notifiedCount++;

    if (driverDoc?.fcmToken) {
      sendNotification([driverDoc.fcmToken], {
        receiver: driverDoc._id,
        message: 'New Ride Request!',
        description: `New ${rideType} ride from ${ridePayload.pickup?.address || 'nearby'}`,
        reference: passengerId,
        modelType: modeType.Passenger,
        data: {
          type: 'RIDE_REQUEST',
          rideId,
          passengerId: passengerId || '',
          bookingId: ridePayload.bookingId || '',
          rideType,
        },
      }).catch((err: any) =>
        console.warn(`FCM failed for online driver ${driverId}:`, err)
      );
    }
  }

  // â”€â”€ Offline drivers â€” availability check + FCM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const offlineDrivers = await User.find({
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
    .select('_id fcmToken location')
    .lean();

  for (const driver of offlineDrivers) {
    const driverId = driver._id.toString();
    if (targetDriverIds?.length && !targetDriverIds.includes(driverId)) continue;
    if (onlineDriverIds.has(driverId)) continue;

    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    // âœ… Availability check
    const availability = await hasDriverRideAtDateTime(
      driverId,
      departureDate,
      departureTime,
      rideType,
      requestedSeats
    );

    if (!availability.available) {
      console.log(
        `â­ï¸ Skipping offline driver ${driverId} â€” ${availability.reason}`
      );
      continue;
    }

    notifiedIds.push(driverId);

    const isKnownOnline = await redis.sismember('users:online', driverId);
    if (isKnownOnline) {
      io.to('driver:' + driverId).emit('ride:new-request', ridePayload);
      notifiedCount++;
    }

    const fcmToken = (driver as any).fcmToken;
    if (fcmToken) {
      try {
        await sendNotification([fcmToken], {
          receiver: driver._id,
          message: 'New Ride Request!',
          description: `New ${rideType} ride from ${ridePayload.pickup?.address || 'nearby'}`,
          reference: passengerId,
          modelType: modeType.Passenger,
          data: {
            type: 'RIDE_REQUEST',
            rideId,
            passengerId: passengerId || '',
            bookingId: ridePayload.bookingId || '',
            rideType,
          },
        });
        if (!isKnownOnline) notifiedCount++;
      } catch (err) {
        console.warn(`FCM failed for offline driver ${driverId}:`, err);
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

// â”€â”€ Notify nearby drivers (split ride â€” route corridor) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Required for availability check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  const onlineDrivers = (await redis.georadius(
    'drivers:location',
    pickup.lng,
    pickup.lat,
    15,
    'km',
    'WITHDIST'
  )) as GeoResult;

  const onlineDriverIds = new Set(onlineDrivers.map(([id]) => id));

  // â”€â”€ Online drivers â€” availability + route check + socket + FCM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  for (const [driverId] of onlineDrivers) {
    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    // âœ… Availability check for split ride
    const availability = await hasDriverRideAtDateTime(
      driverId,
      departureDate,
      departureTime,
      'split',
      requestedSeats
    );

    if (!availability.available) {
      console.log(
        `â­ï¸ Skipping online split driver ${driverId} â€” ${availability.reason}`
      );
      continue;
    }

    const dbDriver = await User.findById(driverId)
      .select('_id fcmToken location isKycVerified')
      .lean();
    if (!dbDriver?.isKycVerified) continue;

    const location = await getDriverCurrentLocation(redis, driverId, dbDriver);
    if (location && !isNearRoute(location.lat, location.lng)) continue;

    io.to(`driver:${driverId}`).emit('ride:new-request', ridePayload);
    notifiedIds.push(driverId);
    notifiedCount++;

    if (dbDriver?.fcmToken) {
      sendNotification([(dbDriver as any).fcmToken], {
        receiver: dbDriver._id,
        message: 'New Split Ride Request!',
        description: `Split ride from ${ridePayload.pickup?.address || 'nearby'}`,
        reference: passengerId || ridePayload.passengerId,
        modelType: modeType.Passenger,
        data: {
          type: 'SPLIT_RIDE_REQUEST',
          rideId,
          passengerId: passengerId || ridePayload.passengerId || '',
          bookingId: ridePayload.bookingId || '',
          rideType: 'split',
        },
      }).catch((err: any) =>
        console.warn(`FCM failed for online split driver ${driverId}:`, err)
      );
    }
  }

  // â”€â”€ Offline drivers â€” availability + route check + FCM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const offlineDrivers = await User.find({
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
    .select('_id fcmToken location')
    .lean();

  for (const driver of offlineDrivers) {
    const driverId = driver._id.toString();
    if (onlineDriverIds.has(driverId)) continue;

    const rejected = await redis.sismember(`ride:rejected:${rideId}`, driverId);
    if (rejected) continue;

    // âœ… Availability check for split ride
    const availability = await hasDriverRideAtDateTime(
      driverId,
      departureDate,
      departureTime,
      'split',
      requestedSeats
    );

    if (!availability.available) {
      console.log(
        `â­ï¸ Skipping offline split driver ${driverId} â€” ${availability.reason}`
      );
      continue;
    }

    const location = await getDriverCurrentLocation(redis, driverId, driver);
    if (location && !isNearRoute(location.lat, location.lng)) continue;

    const shouldNotify = await markDriverNotifiedOnce(rideId, driverId);
    if (!shouldNotify) continue;

    notifiedIds.push(driverId);

    const fcmToken = (driver as any).fcmToken;
    if (fcmToken) {
      try {
        await sendNotification([fcmToken], {
          receiver: driver._id,
          message: 'New Split Ride Request!',
          description: `Split ride from ${ridePayload.pickup?.address || 'nearby'}`,
          reference: passengerId || ridePayload.passengerId,
          modelType: modeType.Passenger,
          data: {
            type: 'SPLIT_RIDE_REQUEST',
            rideId,
            passengerId: passengerId || ridePayload.passengerId || '',
            bookingId: ridePayload.bookingId || '',
            rideType: 'split',
          },
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


