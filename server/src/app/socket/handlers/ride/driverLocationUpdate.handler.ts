// handlers/driver/driverLocationUpdate.handler.ts
import { getRedisClient } from "../../../config/redis.config";
import { PASSENGER_STATUS } from "../../../modules/passenger/passenger.constant";
import { Passenger } from "../../../modules/passenger/passenger.model";
import { RIDE_STATUS, RIDE_TYPE } from "../../../modules/ride/ride.constant";
import { Ride } from "../../../modules/ride/ride.model";
import { isDriverNearPickup, saveDriverLocation } from "../../../utils/geo.utils";
import { calculateETAForRide } from "../../../utils/location.utils";
import { TSocket } from "../../interface/socket.interface";
import { getIO } from "../../socket.init";
import eventHandler from "../../utils/eventHandler";
import { triggerArrival } from "../../utils/triggerArrival";

// configuration
const ARRIVAL_THRESHOLD_METERS = 100; // 100m
const ARRIVAL_COOLDOWN_SECONDS = 30; // 30sec

export const driverLocationUpdateHandler = eventHandler<any>(
  async (socket: TSocket, data: any) => {
    const { rideId, lat, lng, speed, heading } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId || !lat || !lng) return;

    const redis = getRedisClient();
    const io = getIO();

    // 1. save location in redis
    const locationKey = `ride:${rideId}:live`;
    const locationData = JSON.stringify({
      driverId,
      lat,
      lng,
      speed: speed || 0,
      heading: heading || 0,
      timestamp: Date.now(),
    });

    await redis.rpush(locationKey, locationData);
    await redis.expire(locationKey, 7200);
    
    // ড্রাইভারের বর্তমান লোকেশন আলাদা কী-তেও রাখুন (Geofencing এর জন্য)
    await redis.set(`driver:${driverId}:current`, locationData);
    await redis.expire(`driver:${driverId}:current`, 300);
    
    // Redis GEOSET-এ ড্রাইভার লোকেশন যোগ করুন (একাধিক ড্রাইভার খোঁজার জন্য)
    await saveDriverLocation(driverId, lat, lng);

    // 2. find rider
    const ride = await Ride.findById(rideId);
    if (!ride) return;

    // 3. ETA CALCULATION and broadcast
    const eta = await calculateETAForRide(rideId, lat, lng);
    
    io.to(`ride:${rideId}`).emit('ride:live-update', {
      driverId,
      lat,
      lng,
      speed: speed || 0,
      heading: heading || 0,
      eta: eta.etaMinutes,
      distance: eta.distanceKm,
      timestamp: Date.now(),
    });

    // ========== AUTO ARRIVE DETECTION (Redis Geofencing) ==========
    
    // শুধুমাত্র accepted বা driver_assigned স্ট্যাটাসে চেক করব
    const canCheckArrival = ride.status === RIDE_STATUS.accepted || ride.status === RIDE_STATUS.driver_assigned;
    if (!canCheckArrival) return;

    // ইতিমধ্যে অ্যারাইভ নোটিফিকেশন পাঠানো হয়েছে কিনা চেক করুন (কুলডাউন)
    const lastArrivalNotify = await redis.get(`ride:${rideId}:lastArrivalNotify`);
    if (lastArrivalNotify) {
      const timeSinceLastNotify = Date.now() - parseInt(lastArrivalNotify);
      if (timeSinceLastNotify < ARRIVAL_COOLDOWN_SECONDS * 1000) {
        return;
      }
    }

    // ========== PRIVATE RIDE ==========
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({ 
        rideId, 
        status: { $in: [PASSENGER_STATUS.matched, PASSENGER_STATUS.confirmed] },
        arriveAt: { $exists: false }
      });
      
      if (passenger) {
        const pickupLat = ride.pickup.coordinates[1];
        const pickupLng = ride.pickup.coordinates[0];
        
        // Redis Geofencing CHECK
        const nearCheck = await isDriverNearPickup(driverId, pickupLat, pickupLng, ARRIVAL_THRESHOLD_METERS);
        
        if (nearCheck && nearCheck.isNear) {
          await triggerArrival(rideId, passenger._id, driverId, lat, lng, io, redis);
        }
      }
    }
    
    // ========== FOR SPLIT RIDE ==========
    else if (ride.type === RIDE_TYPE.split) {
      const passengers = await Passenger.find({ 
        rideId, 
        status: { $in: [PASSENGER_STATUS.matched, PASSENGER_STATUS.confirmed] },
        arriveAt: { $exists: false }
      });

      for (const passenger of passengers) {
        const pickupLat = passenger.pickup.coordinates[1];
        const pickupLng = passenger.pickup.coordinates[0];
        
        // Redis Geofencing Check
        const nearCheck = await isDriverNearPickup(driverId, pickupLat, pickupLng, ARRIVAL_THRESHOLD_METERS);
        
        if (nearCheck && nearCheck.isNear) {
          await triggerArrival(rideId, passenger._id, driverId, lat, lng, io, redis);
        }
      }
    }
  }
);