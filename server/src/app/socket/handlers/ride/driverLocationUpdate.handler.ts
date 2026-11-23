// handlers/driver/driverLocationUpdate.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { User } from '../../../modules/user/user.model';
import { isDriverNearPickup, saveDriverLocation } from '../../../utils/geo.utils';
import { buildRiderLiveUpdates, pickLeadUpdate } from '../../../utils/liveEta.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { triggerArrival } from '../../utils/triggerArrival';

const ARRIVAL_THRESHOLD_METERS = 100;
const ARRIVAL_COOLDOWN_SECONDS = 30;
const OFFLINE_CHECK_CACHE_SECONDS = 30;

/**
 * Online = in `users:online` (go-online, reconnect restore). Only when the
 * driver is missing from the set is the DB asked (e.g. after a Redis restart);
 * an "offline" answer is cached briefly so an offline app that keeps pinging
 * does not cost a DB read per ping. go-online re-adds the driver to the set,
 * so the cache never delays going back online.
 */
export const isDriverMarkedOnline = async (redis: any, driverId: string): Promise<boolean> => {
  if ((await redis.sismember('users:online', driverId)) === 1) return true;

  const offlineKey = `driver:${driverId}:offline-check`;
  if (await redis.get(offlineKey)) return false;

  const user = await User.findById(driverId).select('isOnline').lean();
  if (user?.isOnline) return true;

  await redis.set(offlineKey, '1', 'EX', OFFLINE_CHECK_CACHE_SECONDS);
  return false;
};

export const driverLocationUpdateHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { lat, lng, speed, heading, encodedRoute } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || lat == null || lng == null) {
      return callback?.({ success: false, message: 'Missing required fields: lat, lng' });
    }

    const redis = getRedisClient();
    const io = getIO();

    // ── 1. Save driver current location ──────────────────────────────────────
    const locationData = JSON.stringify({
      driverId, lat, lng,
      speed: speed || 0,
      heading: heading || 0,
      timestamp: Date.now(),
    });

    // Issue 58: a driver who went offline but whose app keeps sending location
    // used to be put straight back into `users:online` and the GEO index here,
    // so they kept receiving ride requests while their app showed "offline".
    const isAvailable = await isDriverMarkedOnline(redis, driverId);
    if (isAvailable) {
      await Promise.all([
        redis.set(`driver:${driverId}:current`, locationData, 'EX', 300),
        saveDriverLocation(driverId, lat, lng),
        redis.sadd('users:online', driverId).catch(() => {}),
      ]);
    }

    socket.join(`driver:${driverId}`);
    socket.join(`user:${driverId}`);

    // ── 2. Find driver's active ride ──────────────────────────────────────────
    const activeRideId = await redis.get(`driver:${driverId}:activeRide`);

    let ride = null;
    if (activeRideId) {
      ride = await Ride.findById(activeRideId);
      if (ride && ride.status !== RIDE_STATUS.started) {
        ride = null;
      }
    }

    if (!ride) {
      ride = await Ride.findOne({
        driverId,
        status: { $in: [RIDE_STATUS.started] },
      });
    }

    // ── No active ride ────────────────────────────────────────────────────────
    if (!ride) {
      return callback?.({
        success: true,
        hasRide: false,
        isOnline: isAvailable,
        lat,
        lng,
        speed: speed || 0,
        heading: heading || 0,
        timestamp: Date.now(),
        encodedRoute: null,
      });
    }

    const rideId = ride._id.toString();

    // ── 3. Push to live history ───────────────────────────────────────────────
    await Promise.all([
      redis.rpush(`ride:${rideId}:live`, locationData),
      redis.expire(`ride:${rideId}:live`, 7200),
    ]);

    // ── 4 + 5. Per-rider ETA + broadcast (issue 13) ───────────────────────────
    const activePassengers = await Passenger.find({
      rideId,
      status: {
        $in: [
          PASSENGER_STATUS.confirmed,
          PASSENGER_STATUS.driver_arrived,
          PASSENGER_STATUS.in_progress,
          PASSENGER_STATUS.picked_up,
        ],
      },
    })
      .select('userId status pickup destination')
      .lean();

    const riderUpdates = await buildRiderLiveUpdates({ lat, lng }, activePassengers as any);
    const liveBase = {
      driverId,
      lat,
      lng,
      speed: speed || 0,
      heading: heading || 0,
      timestamp: Date.now(),
      encodedRoute: encodedRoute || null,
    };

    // Each rider: their own phase + ETA (0 once the driver has arrived for them).
    for (const update of riderUpdates) {
      io.to(`user:${update.userId}`).emit('ride:live-update', {
        ...liveBase,
        rideId,
        passengerId: update.passengerId,
        phase: update.phase,
        eta: update.eta,
        distance: update.distance,
      });
    }

    // Everyone else in the ride room (driver app, admin): the next stop. Riders
    // are excluded so they never receive a second, conflicting ETA.
    const riderRooms = [...new Set(riderUpdates.map((u) => `user:${u.userId}`))];
    const lead = pickLeadUpdate(riderUpdates);
    io.to(`ride:${rideId}`)
      .except(riderRooms)
      .emit('ride:live-update', {
        ...liveBase,
        rideId,
        passengerId: lead?.passengerId ?? null,
        phase: lead?.phase ?? null,
        eta: lead?.eta ?? 0,
        distance: lead?.distance ?? 0,
      });

    // ── 6. Arrival check — only when accepted ─────────────────────────────────
    if (ride.status !== RIDE_STATUS.accepted) {
      return callback?.({
        success: true,
        hasRide: true,
        rideId,
        lat,
        lng,
        speed: speed || 0,
        heading: heading || 0,
        timestamp: Date.now(),
        encodedRoute: encodedRoute || null,
      });
    }

    // ── 7. Cooldown check ─────────────────────────────────────────────────────
    const lastNotify = await redis.get(`ride:${rideId}:lastArrivalNotify`);
    if (lastNotify) {
      const elapsed = Date.now() - parseInt(lastNotify);
      if (elapsed < ARRIVAL_COOLDOWN_SECONDS * 1000) {
        return callback?.({
          success: true,
          hasRide: true,
          rideId,
          lat,
          lng,
          speed: speed || 0,
          heading: heading || 0,
          timestamp: Date.now(),
          encodedRoute: encodedRoute || null,
        });
      }
    }

    // ── 8. Private ride arrival check ─────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId,
        status: PASSENGER_STATUS.confirmed,
        arrivedNotified: false,
      });

      if (passenger) {
        const pickupLat = ride.pickup.coordinates[1];
        const pickupLng = ride.pickup.coordinates[0];
        const nearCheck = await isDriverNearPickup(driverId, pickupLat, pickupLng, ARRIVAL_THRESHOLD_METERS);

        if (nearCheck?.isNear) {
          await triggerArrival(rideId, passenger._id, driverId, lat, lng, io, redis);
        }
      }

      return callback?.({
        success: true,
        hasRide: true,
        rideId,
        lat,
        lng,
        speed: speed || 0,
        heading: heading || 0,
        timestamp: Date.now(),
        encodedRoute: encodedRoute || null,
      });
    }

    // ── 9. Split ride arrival check ───────────────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      const passengers = await Passenger.find({
        rideId,
        status: PASSENGER_STATUS.confirmed,
        arrivedNotified: false,
      });

      for (const passenger of passengers) {
        const pickupLat = passenger.pickup.coordinates[1];
        const pickupLng = passenger.pickup.coordinates[0];
        const nearCheck = await isDriverNearPickup(driverId, pickupLat, pickupLng, ARRIVAL_THRESHOLD_METERS);

        if (nearCheck?.isNear) {
          await triggerArrival(rideId, passenger._id, driverId, lat, lng, io, redis);
        }
      }

      return callback?.({
        success: true,
        hasRide: true,
        rideId,
        lat,
        lng,
        speed: speed || 0,
        heading: heading || 0,
        timestamp: Date.now(),
        encodedRoute: encodedRoute || null,
      });
    }

    return callback?.({
      success: true,
      hasRide: true,
      rideId,
      lat,
      lng,
      speed: speed || 0,
      heading: heading || 0,
      timestamp: Date.now(),
      encodedRoute: encodedRoute || null,
    });
  },
);