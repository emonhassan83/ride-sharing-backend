import axios from 'axios';
import { getRedisClient } from '../config/redis.config';
import { config } from '../config/env.config';

const GOOGLE_MAPS_API_KEY = config.google_maps_key;

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Calculate distance between two coordinates using Haversine formula
 * @returns distance in kilometers
 */
export function calculateDistance(point1: LatLng, point2: LatLng): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((point2.lat - point1.lat) * Math.PI) / 180;
  const dLon = ((point2.lng - point1.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((point1.lat * Math.PI) / 180) *
      Math.cos((point2.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate total distance from array of locations
 * @returns total distance in kilometers
 */
export function calculateTotalDistance(
  locations: Array<{ lat: number; lng: number }>
): number {
  let total = 0;
  for (let i = 1; i < locations.length; i++) {
    total += calculateDistance(
      { lat: locations[i - 1].lat, lng: locations[i - 1].lng },
      { lat: locations[i].lat, lng: locations[i].lng }
    );
  }
  return total;
}

/**
 * Calculate total duration from locations
 * @returns duration in seconds
 */
export function calculateDuration(
  locations: Array<{ timestamp: number | Date }>
): number {
  if (locations.length < 2) return 0;
  const start = new Date(locations[0].timestamp).getTime();
  const end = new Date(locations[locations.length - 1].timestamp).getTime();
  return (end - start) / 1000;
}

/**
 * Calculate ETA based on current location and destination
 * @returns ETA in minutes
 */
export function calculateETA(
  currentLat: number,
  currentLng: number,
  destinationLat: number,
  destinationLng: number,
  averageSpeed: number = 30 // km/h
): number {
  const distance = calculateDistance(
    { lat: currentLat, lng: currentLng },
    { lat: destinationLat, lng: destinationLng }
  );
  const etaHours = distance / averageSpeed;
  return etaHours * 60; // Return in minutes
}

/**
 * 🆕 Calculate ETA based on distance only
 * @param distanceKm - Distance in kilometers
 * @param averageSpeed - Average speed in km/h (default: 30)
 * @returns ETA in minutes
 *
 * @example
 * calculateETAFromDistance(5, 30) // returns 10 (minutes)
 * calculateETAFromDistance(10, 40) // returns 15 (minutes)
 */
export function calculateETAFromDistance(
  distanceKm: number,
  averageSpeed: number = 30
): number {
  if (distanceKm <= 0) return 0;
  const etaHours = distanceKm / averageSpeed;
  return Math.round(etaHours * 60); // Return in minutes, rounded
}

/**
 * Calculate fare based on distance
 * @returns fare in your currency
 */
export function calculateFareFromDistance(
  distanceKm: number,
  baseFare: number = 50,
  perKmRate: number = 20
): number {
  return baseFare + distanceKm * perKmRate;
}

/**
 * Calculate ETA for a specific ride (async version)
 */
export async function calculateETAForRide(
  rideId: string,
  currentLat: number,
  currentLng: number
): Promise<{ etaMinutes: number; distanceKm: number }> {
  // This requires Ride model - import dynamically to avoid circular dependency
  const { Ride } = await import('../modules/ride/ride.model');

  const ride = await Ride.findById(rideId).select('destination.coordinates');
  if (!ride) {
    return { etaMinutes: 0, distanceKm: 0 };
  }

  const destLat = ride.destination.coordinates[1];
  const destLng = ride.destination.coordinates[0];

  const distance = calculateDistance(
    { lat: currentLat, lng: currentLng },
    { lat: destLat, lng: destLng }
  );

  const etaMinutes = calculateETAFromDistance(distance, 30);

  return { etaMinutes, distanceKm: distance };
}

// =============== Fare Calculation ===============
/**
 * Calculate estimated fare for a ride based on pickup and destination
 * @param pickup - { lat, lng, address? }
 * @param destination - { lat, lng, address? }
 * @returns estimated fare in Taka (or your currency)
 */
export function calculateFare(
  pickup: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): number {
  const distance = calculateDistance(pickup, destination);
  const fare = calculateFareFromDistance(distance);
  return Math.round(fare); // rounded to integer
}

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
    const passengers = await Passenger.find({ rideId, status: 'searching' });
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
        status: 'searching',
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
