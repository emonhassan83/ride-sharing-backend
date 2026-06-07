// utils/maps.utils.ts
import axios from 'axios';
import polyline from '@mapbox/polyline';
import { getRedisClient } from '../config/redis.config';
import { calculateDistance } from './location.utils';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Start matching process for a ride request
 * Finds nearby online drivers and notifies them
 */
export async function startMatchingForRide(rideId: string): Promise<void> {
  try {
    const { getRedisClient } = await import('../config/redis.config');
    const { Ride } = await import('../modules/ride/ride.model');
    const { Passenger } = await import('../modules/passenger/passenger.model');
    const { getIO } = await import('../socket/socket.init');

    const redis = getRedisClient();
    const ride = await Ride.findById(rideId);

    if (!ride) return;

    // Get all searching passengers for this ride
    const passengers = await Passenger.find({ rideId, status: PASSENGER_STATUS.pending });
    if (passengers.length === 0) return;

    // Use first passenger's pickup for driver matching
    const firstPassenger = passengers[0];
    const pickupLat = firstPassenger.pickup.coordinates[1];
    const pickupLng = firstPassenger.pickup.coordinates[0];

    type GeoRadiusResult = Array<[driverId: string, distance: string]>;
    const nearbyDrivers = (await redis.georadius(
      'drivers:location',
      pickupLng,
      pickupLat,
      5,
      'km',
      'WITHDIST'
    )) as GeoRadiusResult;

    const io = getIO();

    if (!nearbyDrivers || nearbyDrivers.length === 0) {
      // No drivers found - will retry later
      console.log(`No drivers found for ride ${rideId}, will retry`);
      return;
    }

    // Calculate total estimated fare for all passengers
    const totalEstimatedFare = passengers.reduce(
      (sum, p) => sum + (p.estimatedFare || 0),
      0
    );

    // Notify each nearby driver
    for (const [driverId, distance] of nearbyDrivers) {
      const rejected = await redis.sismember(
        `ride:rejected:${rideId}`,
        driverId
      );
      if (rejected) continue;

      io.to(`driver:${driverId}`).emit('ride:new-request', {
        rideId: ride._id.toString(),
        pickup: {
          address: firstPassenger.pickup.address,
          lat: pickupLat,
          lng: pickupLng,
        },
        destination: {
          address: ride.destination.address,
          lat: ride.destination.coordinates[1],
          lng: ride.destination.coordinates[0],
        },
        passengerCount: passengers.length,
        totalSeats: passengers.reduce((sum, p) => sum + p.requestedSeats, 0),
        distance: parseFloat(distance),
        estimatedFare: totalEstimatedFare,
        expiresIn: 15,
      });
    }

    // Set timeout to retry if no driver accepts
    setTimeout(async () => {
      const stillSearching = await Passenger.countDocuments({
        rideId,
        status: PASSENGER_STATUS.pending,
      });
      if (stillSearching > 0) {
        console.log(
          `Retrying matching for ride ${rideId}, ${stillSearching} passengers still searching`
        );
        startMatchingForRide(rideId);
      }
    }, 10 * 60000); //  10 মিনিট = 10 * 6০০০০ মিলিসেকেন্ড
  } catch (error) {
    console.error('Error in startMatchingForRide:', error);
  }
}

/**
 * Distance Matrix API থেকে দুটি লোকেশনের মধ্যে প্রকৃত দূরত্ব (কিমি) ও সময় (মিনিট) বের করে
 * ফলাফল Redis-এ ৫ মিনিট ক্যাশ করে রাখে যাতে বারবার API কল না হয়
 */
export async function getRealDistanceAndETA(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): Promise<{ distanceKm: number; durationMinutes: number }> {
  // API Key চেক
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn(
      '⚠️ Google Maps API key not configured, using straight-line distance'
    );
    const distanceKm = calculateDistance(origin, destination);
    const durationMinutes = Math.max(1, Math.round((distanceKm / 30) * 60));
    return { distanceKm, durationMinutes };
  }

  const cacheKey = `map:distance:${origin.lat.toFixed(6)},${origin.lng.toFixed(6)}:${destination.lat.toFixed(6)},${destination.lng.toFixed(6)}`;
  const redis = getRedisClient();

  // 1. ক্যাশে থাকলে রিটার্ন করুন
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      console.log(
        `📦 Cache hit: ${origin.lat},${origin.lng} → ${destination.lat},${destination.lng} = ${parsed.distanceKm}km, ${parsed.durationMinutes}min`
      );
      return parsed;
    }
  } catch (err) {
    console.error('Redis cache read error:', err);
  }

  // 2. Google Maps API কল করুন (ট্রাফিক সহ)
  const url = 'https://maps.googleapis.com/maps/api/distancematrix/json';

  try {
    const response = await axios.get(url, {
      params: {
        origins: `${origin.lat},${origin.lng}`,
        destinations: `${destination.lat},${destination.lng}`,
        key: GOOGLE_MAPS_API_KEY,
        units: 'metric',
        departure_time: 'now', // বর্তমান ট্রাফিক বিবেচনা
        traffic_model: 'best_guess', // সেরা ট্রাফিক মডেল
      },
      timeout: 5000, // 5 সেকেন্ড টাইমআউট
    });

    const element = response.data.rows[0]?.elements[0];

    if (!element || element.status !== 'OK') {
      console.error('Distance Matrix API error:', element?.status);
      // Fallback: সরলরেখার দূরত্ব ও সময়
      const distanceKm = calculateDistance(origin, destination);
      const durationMinutes = Math.max(1, Math.round((distanceKm / 30) * 60));
      return { distanceKm, durationMinutes };
    }

    // দূরত্ব (মিটার → কিমি)
    const distanceKm = element.distance.value / 1000;

    // ✅ অগ্রাধিকার: duration_in_traffic → duration → fallback
    let durationSeconds =
      element.duration_in_traffic?.value || element.duration?.value;

    // যদি duration_in_traffic না থাকে, তাহলে আনুমানিক সময় (ট্রাফিক ছাড়া)
    if (!durationSeconds) {
      durationSeconds = (distanceKm / 30) * 3600; // 30 km/h গড় স্পিড
    }

    const durationMinutes = Math.max(1, Math.ceil(durationSeconds / 60));

    const result = { distanceKm, durationMinutes };
    console.log(
      `📍 Google Maps: ${origin.lat},${origin.lng} → ${destination.lat},${destination.lng} = ${distanceKm.toFixed(2)}km, ${durationMinutes}min (traffic-aware)`
    );

    // 3. ১০ মিনিটের জন্য ক্যাশ করুন
    try {
      await redis.setex(cacheKey, 600, JSON.stringify(result));
    } catch (err) {
      console.error('Redis cache write error:', err);
    }

    return result;
  } catch (error) {
    console.error('Google Maps API request failed:', error);
    // Fallback: সরলরেখার দূরত্ব ও সময়
    const distanceKm = calculateDistance(origin, destination);
    const durationMinutes = Math.max(1, Math.round((distanceKm / 30) * 60));
    return { distanceKm, durationMinutes };
  }
}


export async function getRouteGeometry(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): Promise<{ type: 'LineString'; coordinates: number[][] }> {
  const url = 'https://maps.googleapis.com/maps/api/directions/json';
  const response = await axios.get(url, {
    params: {
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      key: GOOGLE_MAPS_API_KEY,
    },
  });

  const route = response.data.routes[0];
  if (!route || !route.overview_polyline) {
    throw new Error('No route found');
  }

  const points = polyline.decode(route.overview_polyline.points);
  const coordinates = points.map(point => [point[1], point[0]]); // [lng, lat] for GeoJSON
  return {
    type: 'LineString',
    coordinates,
  };
}