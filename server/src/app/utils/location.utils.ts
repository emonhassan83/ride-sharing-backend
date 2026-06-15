import { RIDE_STATUS } from '../modules/ride/ride.constant';
import { Ride } from '../modules/ride/ride.model';
import { ICalculateETAForRide, ILatLng } from '../socket/interface/ride';
import { getRealDistanceAndETA } from './maps.utils';

/**
 * Calculate distance between two coordinates using Haversine formula
 * @returns distance in kilometers
 */
export function calculateDistance(point1: ILatLng, point2: ILatLng): number {
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
  locations: Array<ILatLng>
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
 * Calculate ETA for a specific ride (async version)
 */
export async function calculateETAForRide(
  rideId: string,
  currentLat: number,
  currentLng: number,
  rideStatus?: string,
): Promise<ICalculateETAForRide> {
  const ride = await Ride.findById(rideId).select('pickup destination status');
  if (!ride) return { etaMinutes: 0, distanceKm: 0 };

  const status = rideStatus || ride.status;

  // accepted → driver is heading to PICKUP
  // started  → driver is heading to DESTINATION
  const isHeadingToPickup = status === RIDE_STATUS.accepted;

  const targetLat = isHeadingToPickup
    ? ride.pickup.coordinates[1]
    : ride.destination.coordinates[1];

  const targetLng = isHeadingToPickup
    ? ride.pickup.coordinates[0]
    : ride.destination.coordinates[0];

  try {
    const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
      { lat: currentLat, lng: currentLng },
      { lat: targetLat,  lng: targetLng  },
    );

    console.log(
      `📍 ETA (${isHeadingToPickup ? 'to pickup' : 'to destination'}): ${distanceKm.toFixed(2)}km, ${durationMinutes}min`,
    );

    return { etaMinutes: durationMinutes, distanceKm };
  } catch (err) {
    // Fallback to Haversine if Google Maps fails
    console.warn('⚠️ Google Maps ETA failed, using Haversine fallback');
    const distance    = calculateDistance(
      { lat: currentLat, lng: currentLng },
      { lat: targetLat,  lng: targetLng  },
    );
    const etaMinutes = calculateETAFromDistance(distance, 30);
    return { etaMinutes, distanceKm: distance };
  }
}
