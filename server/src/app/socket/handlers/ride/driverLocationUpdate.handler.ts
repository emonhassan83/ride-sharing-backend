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

const ARRIVAL_THRESHOLD_METERS  = 100;
const ARRIVAL_COOLDOWN_SECONDS  = 30;

export const driverLocationUpdateHandler = eventHandler<any>(
  async (socket: TSocket, data: any) => {
    const { rideId, lat, lng, speed, heading } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId || lat == null || lng == null) {
      console.log(`❌ Missing data — driverId: ${driverId}, rideId: ${rideId}, lat: ${lat}, lng: ${lng}`);
      return;
    }

    const redis = getRedisClient();
    const io    = getIO();

    // ── 1. Save location in Redis ─────────────────────────────────────────────
    const locationData = JSON.stringify({
      driverId,
      lat,
      lng,
      speed:     speed   || 0,
      heading:   heading || 0,
      timestamp: Date.now(),
    });

    await Promise.all([
      redis.rpush(`ride:${rideId}:live`, locationData),
      redis.expire(`ride:${rideId}:live`, 7200),
      redis.set(`driver:${driverId}:current`, locationData, 'EX', 300),
      saveDriverLocation(driverId, lat, lng),
    ]);

    // ── 2. Find ride ──────────────────────────────────────────────────────────
    const ride = await Ride.findById(rideId);
    if (!ride) {
      console.log(`❌ Ride not found: ${rideId}`);
      return;
    }

    // ── 3. Calculate ETA to destination ──────────────────────────────────────
    const eta = await calculateETAForRide(rideId, lat, lng);

    // ── 4. Room debug + broadcast live update ─────────────────────────────────
    const roomSockets = await io.in(`ride:${rideId}`).fetchSockets();
    console.log(`🛋️ Room ride:${rideId} has ${roomSockets.length} socket(s)`);

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

    console.log(`📡 ride:live-update → room ride:${rideId} | eta: ${eta.etaMinutes}min | dist: ${eta.distanceKm}km`);

    // ── 5. Arrival check — only when accepted ─────────────────────────────────
    if (ride.status !== RIDE_STATUS.started) {
      console.log(`⏭️ Skipping arrival check — ride status: ${ride.status}`);
      return;
    }

    // ── 6. Cooldown check ─────────────────────────────────────────────────────
    const lastNotify = await redis.get(`ride:${rideId}:lastArrivalNotify`);
    if (lastNotify) {
      const elapsed = Date.now() - parseInt(lastNotify);
      if (elapsed < ARRIVAL_COOLDOWN_SECONDS * 1000) {
        console.log(`⏱️ Cooldown: ${Math.round((ARRIVAL_COOLDOWN_SECONDS * 1000 - elapsed) / 1000)}s remaining`);
        return;
      }
    }

    // ── 7. Private ride arrival check ─────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId,
        status:          PASSENGER_STATUS.in_progress,
        arrivedNotified: false,
      });

      if (!passenger) {
        console.log(`⚠️ No unnotified passenger for private ride ${rideId}`);
        return;
      }

      const pickupLat = ride.pickup.coordinates[1];
      const pickupLng = ride.pickup.coordinates[0];

      console.log(`🎯 Pickup: lat=${pickupLat}, lng=${pickupLng} | Driver: lat=${lat}, lng=${lng}`);

      const nearCheck = await isDriverNearPickup(
        driverId, pickupLat, pickupLng, ARRIVAL_THRESHOLD_METERS,
      );

      console.log(`📏 Distance: ${nearCheck?.distanceMeters ?? 'N/A'}m | threshold: ${ARRIVAL_THRESHOLD_METERS}m | isNear: ${nearCheck?.isNear}`);

      if (nearCheck?.isNear) {
        console.log(`🚗 Driver arrived at pickup for private ride ${rideId}`);
        await triggerArrival(rideId, passenger._id, driverId, lat, lng, io, redis);
      }

      return;
    }

    // ── 8. Split ride arrival check ───────────────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      const passengers = await Passenger.find({
        rideId,
        status:          PASSENGER_STATUS.in_progress,
        arrivedNotified: false,
      });

      console.log(`👥 ${passengers.length} unnotified passenger(s) for split ride ${rideId}`);

      for (const passenger of passengers) {
        const pickupLat = passenger.pickup.coordinates[1];
        const pickupLng = passenger.pickup.coordinates[0];

        console.log(`🎯 Passenger ${passenger._id} pickup: lat=${pickupLat}, lng=${pickupLng}`);

        const nearCheck = await isDriverNearPickup(
          driverId, pickupLat, pickupLng, ARRIVAL_THRESHOLD_METERS,
        );

        console.log(`📏 Passenger ${passenger._id}: ${nearCheck?.distanceMeters ?? 'N/A'}m | isNear: ${nearCheck?.isNear}`);

        if (nearCheck?.isNear) {
          console.log(`🚗 Driver arrived at passenger ${passenger._id} pickup`);
          await triggerArrival(rideId, passenger._id, driverId, lat, lng, io, redis);
        }
      }
    }
  },
);