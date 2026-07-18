// utils/maps.utils.ts
import axios from 'axios';
import polyline from '@mapbox/polyline';
import { getRedisClient } from '../config/redis.config';
import { calculateDistance } from './location.utils';
import { ILatLng, IRealDistanceAndETA, IRouteGeometry } from '../socket/interface/ride';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Distance Matrix API থেকে দুটি লোকেশনের মধ্যে প্রকৃত দূরত্ব (কিমি) ও সময় (মিনিট) বের করে
 * ফলাফল Redis-এ ৫ মিনিট ক্যাশ করে রাখে যাতে বারবার API কল না হয়
 */
export async function getRealDistanceAndETA(
  origin: ILatLng,
  destination: ILatLng
): Promise<IRealDistanceAndETA> {
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
  origin: ILatLng,
  destination: ILatLng
): Promise<IRouteGeometry> {
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