// handlers/driver/driverLocationUpdate.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { isDriverNearPickup, saveDriverLocation } from '../../../utils/geo.utils';
import { calculateETAForRide } from '../../../utils/location.utils';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { triggerArrival } from '../../utils/triggerArrival';

const ARRIVAL_THRESHOLD_METERS = 100;
const ARRIVAL_COOLDOWN_SECONDS = 30;

export const driverLocationUpdateHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { lat, lng, speed, heading } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || lat == null || lng == null) {
      return callback?.({ success: false, message: 'Missing required fields: lat, lng' });
    }

    const redis = getRedisClient();
    const io    = getIO();

    // ── 1. Save driver current location ──────────────────────────────────────
    const locationData = JSON.stringify({
      driverId, lat, lng,
      speed:     speed   || 0,
      heading:   heading || 0,
      timestamp: Date.now(),
    });

    await Promise.all([
      redis.set(`driver:${driverId}:current`, locationData, 'EX', 300),
      saveDriverLocation(driverId, lat, lng),
    ]);

    // ── 2. Find driver's active ride ──────────────────────────────────────────
    const activeRideId = await redis.get(`driver:${driverId}:activeRide`);

    let ride = null;
    if (activeRideId) {
      ride = await Ride.findById(activeRideId);
    }

    if (!ride) {
      ride = await Ride.findOne({
        driverId,
        status: { $in: [RIDE_STATUS.accepted, RIDE_STATUS.started] },
      });
    }

    // ── No active ride ────────────────────────────────────────────────────────
    if (!ride) {
      return callback?.({
        success:   true,
        hasRide:   false,
        lat,
        lng,
        speed:     speed   || 0,
        heading:   heading || 0,
        timestamp: Date.now(),
      });
    }

    const rideId = ride._id.toString();

    // ── 3. Push to live history ───────────────────────────────────────────────
    await Promise.all([
      redis.rpush(`ride:${rideId}:live`, locationData),
      redis.expire(`ride:${rideId}:live`, 7200),
    ]);

    // ── 4. Calculate ETA ──────────────────────────────────────────────────────
    const eta = await calculateETAForRide(rideId, lat, lng, ride.status);

    // ── 5. Broadcast to ride room ─────────────────────────────────────────────
    io.to(`ride:${rideId}`).emit('ride:live-update', {
      driverId,
      lat,
      lng,
      speed:     speed   || 0,
      heading:   heading || 0,
      eta:       eta.etaMinutes,
      distance:  eta.distanceKm,
      timestamp: Date.now(),
    });

    // ── 6. Arrival check — only when accepted ─────────────────────────────────
    if (ride.status !== RIDE_STATUS.accepted) {
      return callback?.({
        success:   true,
        hasRide:   true,
        rideId,
        lat,
        lng,
        speed:     speed   || 0,
        heading:   heading || 0,
        timestamp: Date.now(),
      });
    }

    // ── 7. Cooldown check ─────────────────────────────────────────────────────
    const lastNotify = await redis.get(`ride:${rideId}:lastArrivalNotify`);
    if (lastNotify) {
      const elapsed = Date.now() - parseInt(lastNotify);
      if (elapsed < ARRIVAL_COOLDOWN_SECONDS * 1000) {
        return callback?.({
          success:   true,
          hasRide:   true,
          rideId,
          lat,
          lng,
          speed:     speed   || 0,
          heading:   heading || 0,
          timestamp: Date.now(),
        });
      }
    }

    // ── 8. Private ride arrival check ─────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId,
        status:          PASSENGER_STATUS.confirmed,
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
        success:   true,
        hasRide:   true,
        rideId,
        lat,
        lng,
        speed:     speed   || 0,
        heading:   heading || 0,
        timestamp: Date.now(),
      });
    }

    // ── 9. Split ride arrival check ───────────────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      const passengers = await Passenger.find({
        rideId,
        status:          PASSENGER_STATUS.confirmed,
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
        success:   true,
        hasRide:   true,
        rideId,
        lat,
        lng,
        speed:     speed   || 0,
        heading:   heading || 0,
        timestamp: Date.now(),
      });
    }

    return callback?.({
      success:   true,
      hasRide:   true,
      rideId,
      lat,
      lng,
      speed:     speed   || 0,
      heading:   heading || 0,
      timestamp: Date.now(),
    });
  },
);