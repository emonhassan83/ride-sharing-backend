import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Ride } from './ride.model';
import { User } from '../user/user.model';
import { FareUtils } from './ride.utils';
import { getRedisClient } from '../../config/redis.config';
import { calculateETAFromDistance } from '../../utils/location.utils';
import { GeoLocation, NearbyDriver } from './ride.interface';

// ==================== USER SIDE ====================
const findNearbyDrivers = async (
  location: GeoLocation,
  radiusKm: number = 5
): Promise<NearbyDriver[]> => {
  const redis = getRedisClient();
  
  try {
    // Type-safe geosearch
    const results = await redis.call(
      'GEOSEARCH',
      'drivers:location',
      'FROMLONLAT',
      location.lng.toString(),
      location.lat.toString(),
      'BYRADIUS',
      radiusKm.toString(),
      'km',
      'WITHDIST'
    ) as string[];
    
    if (!results || !results.length) return [];
    
    const drivers: NearbyDriver[] = [];
    
    // Results format: [driverId, distance, driverId, distance, ...]
    for (let i = 0; i < results.length; i += 2) {
      const driverId = results[i];
      const distance = parseFloat(results[i + 1]);
      
      const details = await redis.hgetall(`driver:${driverId}:details`);
      if (details && details.status === 'available') {
        drivers.push({ driverId, distance, details });
      }
    }
    
    return drivers.sort((a, b) => a.distance - b.distance);
  } catch (error) {
    console.error('GEOSEARCH error:', error);
    return [];
  }
};

// Main function using the utility
const findNearbyAvailableDrivers = async (
  payload: { pickupLat: number; pickupLng: number },
  query: { radiusKm?: number }
) => {
  const { pickupLat, pickupLng } = payload;
  const { radiusKm = 5 } = query;
  
  const nearbyDrivers = await findNearbyDrivers(
    { lat: pickupLat, lng: pickupLng },
    radiusKm
  );
  
  return nearbyDrivers.map((driver) => ({
    driverId: driver.driverId,
    name: driver.details.name,
    phone: driver.details.phone,
    rating: parseFloat(driver.details.rating),
    photo: driver.details.photo,
    vehicleModel: driver.details.vehicleModel,
    vehicleNumber: driver.details.vehicleNumber,
    seats: parseInt(driver.details.seats),
    distance: driver.distance,
    lastLat: parseFloat(driver.details.lastLat),
    lastLng: parseFloat(driver.details.lastLng),
    eta: calculateETAFromDistance(driver.distance, 30),
  }));
};

const createRideRequest = async (userId: string, payload: any) => {
  const { driverId, ...rest } = payload;

  // Driver Validation
  const driver = await User.findById(driverId);
  if (!driver) throw new ApiError(StatusCodes.NOT_FOUND, 'Driver not found');

  // Fare Calculation
  const fareData = await FareUtils.calculateFare({
    estimatedDistanceKm: rest.estimatedDistanceKm,
    rideType: rest.rideType,
    requestedSeats: rest.requestedSeats,
    isNightTrip: rest.isNightTrip || false,
    waitingMinutes: rest.waitingMinutes || 0,
    isPublicHoliday: rest.isPublicHoliday || false,
    luggageBackpackCount: rest.luggagePolicy?.backpackCounts || 0,
  });

  const ride = await Ride.create({
    ...rest,
    userId,
    driverId,
    estimatedFare: fareData.userPayable,
    status: 'pending',
    tripStatus: 'upcoming',
    bookedSeats: 0,
  });

  return ride;
};

const getMyRideRequests = async (userId: string, status?: string) => {
  const query: any = { userId };

  if (status) {
    query.status = status;
  }

  return Ride.find(query)
    .populate('driverId', 'name phone profileImage avgRating')
    .populate('vehicleId', 'name number year')
    .sort({ createdAt: -1 });
};

// ==================== DRIVER SIDE ====================

const getAvailableRideRequests = async (
  driverId: string,
  filters: any = {}
) => {
  const query: any = {
    driverId,
    status: 'pending',
  };

  if (filters.rideType) query.rideType = filters.rideType;

  return Ride.find(query)
    .populate('userId', 'name phone profileImage avgRating')
    .sort({ createdAt: -1 });
};

const getRideById = async (rideId: string) => {
  const ride = await Ride.findById(rideId)
    .populate('userId', 'name phone')
    .populate('driverId', 'name phone profileImage')
    .populate('vehicleId');

  if (!ride) throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');

  return ride;
};

export const RideService = {
  findNearbyAvailableDrivers,
  createRideRequest,
  getMyRideRequests,
  getAvailableRideRequests,
  getRideById,
};
