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