// utils/geo.utils.ts
import { getRedisClient } from '../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../modules/ride/ride.constant';
import { Ride } from '../modules/ride/ride.model';
import { User } from '../modules/user/user.model';
import { Vehicle } from '../modules/vehicle/vehicle.model';
import { calculateDistance, calculateFareFromDistance } from './location.utils';
import { getRealDistanceAndETA } from './maps.utils';

const DESTINATION_MATCH_RADIUS_KM = 5;

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Driver location set in Redis (GEOSET)
 */
export async function saveDriverLocation(
  driverId: string,
  lat: number,
  lng: number
): Promise<void> {
  const redis = getRedisClient();
  await redis.geoadd('drivers:location', lng, lat, driverId);

  // TTL সেট করা ঐচ্ছিক – পুরো কীতে expire দিতে চাইলে সতর্ক থাকুন, কারণ অন্য ড্রাইভার থাকলে কী মুছে যাবে
  // await redis.expire('drivers:location', 7200);
}

/**
 * Driver location removed from Redis
 */
export async function removeDriverLocation(driverId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.zrem('drivers:location', driverId);
}

/**
 * Check driver has nearby location or not
 */
export async function isDriverNearPickup(
  driverId: string,
  pickupLat: number,
  pickupLng: number,
  thresholdMeters: number = 100
): Promise<{ isNear: boolean; distanceMeters: number } | null> {
  const redis = getRedisClient();

  const driverLocation = await redis.get(`driver:${driverId}:current`);
  if (!driverLocation) return null;

  const { lat, lng } = JSON.parse(driverLocation);
  const distanceMeters = calculateDistanceInMeters(
    lat,
    lng,
    pickupLat,
    pickupLng
  );

  return {
    isNear: distanceMeters <= thresholdMeters,
    distanceMeters: Math.round(distanceMeters),
  };
}

/**
 * Haversine formula: use for use calculation distance meters
 */
export function calculateDistanceInMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Redis GEOSEARCH use for search get nearby driver
 */
export async function findNearbyDrivers(
  pickupLat: number,
  pickupLng: number,
  radiusMeters: number = 5000
): Promise<Array<{ driverId: string; distanceMeters: number }>> {
  const redis = getRedisClient();

  const nearbyDrivers = (await redis.georadius(
    'drivers:location',
    pickupLng,
    pickupLat,
    radiusMeters,
    'm',
    'WITHDIST'
  )) as Array<[driverId: string, distance: string]>;

  return nearbyDrivers.map(([driverId, distance]) => ({
    driverId,
    distanceMeters: Math.round(parseFloat(distance)),
  }));
}

/**
 * Result of driver availability check
 */
interface DriverAvailability {
  available: boolean; // true if driver can be shown to passenger
  rideId?: string; // if joining an existing split ride, the ride ID
  reason?: string; // optional debug info
}

/**
 * Check driver availability for a ride request (new ride or join existing ride)
 *
 * @param driverId - Driver's user ID
 * @param requestedDate - Date string 'YYYY-MM-DD'
 * @param requestedTime - Time string 'HH:MM'
 * @param rideType - 'private' or 'split'
 * @param requestedSeats - Number of seats passenger wants
 * @param existingRideId - If joining an existing ride, provide ride ID; else undefined
 * @returns DriverAvailability object
 */
export async function hasDriverRideAtDateTime(
  driverId: string,
  requestedDate: string,
  requestedTime: string,
  rideType: string,
  requestedSeats: number,
  existingRideId?: string
): Promise<DriverAvailability> {
  const BUFFER_MINUTES = 120; // 2 hours buffer

  // Helper: Convert "HH:MM" to minutes since midnight
  const toMinutes = (timeStr: string) => {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  };

  const reqMinutes = toMinutes(requestedTime);
  const startMinutes = reqMinutes - BUFFER_MINUTES;
  const endMinutes = reqMinutes + BUFFER_MINUTES;

  // Find all active rides of this driver on the same date
  const driverRides = await Ride.find({
    driverId,
    departureDate: requestedDate,
    status: {
      $nin: [
        RIDE_STATUS.rejected,
        RIDE_STATUS.cancelled,
        RIDE_STATUS.completed,
      ],
    },
  }).lean();

  // --- Case: Joining an existing ride (split only) ---
  if (existingRideId) {
    const targetRide = await Ride.findById(existingRideId).lean();
    if (!targetRide || targetRide.driverId?.toString() !== driverId) {
      return {
        available: false,
        reason: 'Ride not found or not owned by driver',
      };
    }
    if (targetRide.type !== RIDE_TYPE.split) {
      return { available: false, reason: 'Cannot join non-split ride' };
    }
    const availableSeats =
      targetRide.totalSeats - (targetRide.bookedSeats || 0);
    if (availableSeats >= requestedSeats) {
      return {
        available: true,
        rideId: targetRide._id.toString(),
        reason: 'Join existing ride',
      };
    } else {
      return { available: false, reason: 'Not enough seats' };
    }
  }

  // --- Case: New ride request (private or split first passenger) ---
  // Check for any conflicting ride within buffer window
  for (const ride of driverRides) {
    const rideMinutes = toMinutes(ride.departureTime);
    const isWithinBuffer =
      rideMinutes >= startMinutes && rideMinutes <= endMinutes;
    if (!isWithinBuffer) continue;

    // Conflict detected
    if (ride.type === RIDE_TYPE.private) {
      // Private ride blocks everything
      return {
        available: false,
        reason: 'Driver has private ride within buffer',
      };
    } else if (ride.type === RIDE_TYPE.split) {
      // Split ride conflict: cannot start another new ride at overlapping time
      return {
        available: false,
        reason: 'Driver has split ride within buffer',
      };
    }
  }

  // No conflict found – driver is free for new ride
  return { available: true, reason: 'Driver free' };
}

/**
 * Find drivers within radius and enrich with details
 */
export async function fetchDriversWithinRadius(
  redis: any,
  lng: number,
  lat: number,
  radiusKm: number,
  rideType: string,
  requestedSeats: number,
  passengerDestination: { lat: number; lng: number },
  departureDate: string,
  departureTime: string
): Promise<any[]> {
  type GeoRadiusResult = Array<[driverId: string, distance: string]>;
  const nearbyDrivers = (await redis.georadius(
    'drivers:location',
    lng,
    lat,
    radiusKm,
    'km',
    'WITHDIST'
  )) as GeoRadiusResult;

  if (!nearbyDrivers || nearbyDrivers.length === 0) return [];

  const driversData = [];

  for (const [driverId, distanceStr] of nearbyDrivers) {
    const geoDistanceKm = parseFloat(distanceStr);

    // ✅ Check driver availability (new ride, no existing ride ID)
    const availability = await hasDriverRideAtDateTime(
      driverId,
      departureDate,
      departureTime,
      rideType,
      requestedSeats,
      undefined // new ride
    );

    if (!availability.available) continue; // driver busy

    // Driver details from Redis/DB (same as before)
    let driverDetails = await redis.hgetall(`driver:${driverId}:details`);
    let driverName = 'Unknown';
    let driverEmail = '';
    let driverPhone = '';
    let driverRating = 5;
    let driverPhoto = null;
    let vehicleModel = 'Standard';
    let vehicleNumber = '';
    let totalSeats = 4;
    let bookedSeats = 0;
    let driverDestination = null;
    let driverLastLat = lat;
    let driverLastLng = lng;

    if (driverDetails && Object.keys(driverDetails).length > 0) {
      driverName = driverDetails.name || 'Unknown';
      driverEmail   = driverDetails.email         || '';   // ✅ যোগ করুন
      driverPhone   = driverDetails.phone         || '';   // ✅ যোগ করুন
      driverRating = parseFloat(driverDetails.rating) || 5;
      driverPhoto = driverDetails.photo;
      vehicleModel = driverDetails.vehicleModel || 'Standard';
      vehicleNumber = driverDetails.vehicleNumber || '';
      totalSeats = parseInt(driverDetails.seats) || 4;
      bookedSeats = parseInt(driverDetails.bookedSeats) || 0;
      if (driverDetails.destination)
        driverDestination = JSON.parse(driverDetails.destination);
      driverLastLat = parseFloat(driverDetails.lastLat) || lat;
      driverLastLng = parseFloat(driverDetails.lastLng) || lng;
    } else {
      const driver = await User.findById(driverId)
        .select('name email phone avgRating profileImage location')
        .lean();
      const vehicle = await Vehicle.findOne({
        userId: driverId,
        isDefault: true,
      }).lean();

      driverName = driver?.name || 'Unknown';
      driverEmail = driver?.email || '';
      driverPhone = driver?.phone || '';
      driverRating = driver?.avgRating || 5;
      driverPhoto = driver?.profileImage;
      vehicleModel = vehicle?.name || 'Standard';
      vehicleNumber = vehicle?.number || '';
      totalSeats = vehicle?.seats || 4;
      bookedSeats = 0;
      if (driver?.location?.coordinates) {
        driverLastLng = driver.location.coordinates[0];
        driverLastLat = driver.location.coordinates[1];
      }
    }

    const availableSeats = totalSeats - bookedSeats;

    // Additional seat check for new ride (though already done inside hasDriverRideAtDateTime for split)
    if (rideType === 'private' && totalSeats < requestedSeats) continue;
    if (rideType === 'split' && availableSeats < requestedSeats) continue;

    // Destination validation for split (optional)
    let destinationValid = true;
    if (rideType === 'split' && driverDestination) {
      const distanceToPassengerDest = calculateDistance(
        { lat: driverDestination.lat, lng: driverDestination.lng },
        { lat: passengerDestination.lat, lng: passengerDestination.lng }
      );
      if (distanceToPassengerDest > DESTINATION_MATCH_RADIUS_KM)
        destinationValid = false;
    }
    if (!destinationValid) continue;

    // Distance, ETA, fare (same as before)
    let realDistance = geoDistanceKm;
    let etaMinutes = Math.round((geoDistanceKm / 30) * 60);
    let estimatedFare = calculateFareFromDistance(geoDistanceKm);
    try {
      const driverLocation = { lat: driverLastLat, lng: driverLastLng };
      const pickupPoint = { lat, lng };
      const { distanceKm, durationMinutes } = await getRealDistanceAndETA(
        driverLocation,
        pickupPoint
      );
      realDistance = distanceKm;
      etaMinutes = durationMinutes;
      estimatedFare = calculateFareFromDistance(realDistance);
    } catch (err) {
      console.error(`Google Maps error for driver ${driverId}:`, err);
    }

    driversData.push({
      driverId,
      driverName,
      driverEmail,
      driverPhone,
      driverRating,
      driverPhoto,
      vehicle: {
        model: vehicleModel,
        number: vehicleNumber,
        seats: totalSeats,
        availableSeats,
      },
      distance: parseFloat(realDistance.toFixed(2)),
      eta: Math.round(etaMinutes),
      estimatedFare: Math.round(estimatedFare),
      // If needed, you can also include existing ride ID for split ride joining
      // existingRideId: availability.rideId || null
    });
  }

  return driversData;
}

export const haversineMeters = (
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number => {
  const R = 6378100;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};