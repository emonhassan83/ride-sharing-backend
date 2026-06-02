// utils/maps.utils.ts
import axios from 'axios';
import polyline from '@mapbox/polyline';

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