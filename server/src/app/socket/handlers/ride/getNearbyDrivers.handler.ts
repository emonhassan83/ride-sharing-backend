// handlers/ride/getNearbyDrivers.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { fetchDriversWithinRadius } from '../../../utils/geo.utils';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { TSocket } from '../../interface/socket.interface';
import eventHandler from '../../utils/eventHandler';

export const getNearbyDriversHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const {
      pickup,
      destination,
      rideType,
      passengers,
      departureDate,
      departureTime,
    } = data;

    if (!pickup?.lat || !pickup?.lng || !destination?.lat || !destination?.lng)
      return callback?.({ success: false, message: 'Pickup and destination required' });

    if (!departureDate || !departureTime)
      return callback?.({ success: false, message: 'Departure date and time are required' });

    const redis          = getRedisClient();
    const requestedSeats = rideType === 'split' && passengers > 0 ? passengers : 1;

    try {
      // ── Find nearby drivers (5km first, expand to 10km if none) ────────────
      let drivers = await fetchDriversWithinRadius(
        redis, pickup.lng, pickup.lat, 5,
        rideType, requestedSeats, destination, departureDate, departureTime,
      );

      if (drivers.length === 0) {
        drivers = await fetchDriversWithinRadius(
          redis, pickup.lng, pickup.lat, 10,
          rideType, requestedSeats, destination, departureDate, departureTime,
        );
      }

      if (drivers.length === 0) {
        return callback?.({
          success: true,
          message: 'No drivers available within 10 km for the selected date and time.',
          data: [],
        });
      }

      // ── Enrich each driver with Google Maps distance/ETA + current location ─
      const enriched = await Promise.all(
        drivers.map(async (driver) => {
          // Get driver's current location from Redis
          let driverLat: number | null = null;
          let driverLng: number | null = null;

          try {
            const currentRaw = await redis.get(`driver:${driver.driverId}:current`);
            if (currentRaw) {
              const current = JSON.parse(currentRaw);
              driverLat = current.lat;
              driverLng = current.lng;
            }
          } catch {
            // fallback — no current location
          }

          // Google Maps real distance & ETA from driver → pickup
          let distanceKm    = driver.distance;
          let etaMinutes    = Math.round((distanceKm / 30) * 60);

          if (driverLat !== null && driverLng !== null) {
            try {
              const result = await getRealDistanceAndETA(
                { lat: driverLat, lng: driverLng },
                { lat: pickup.lat,  lng: pickup.lng  },
              );
              distanceKm  = result.distanceKm;
              etaMinutes  = result.durationMinutes;
            } catch {
              // keep fallback values
            }
          }

          return {
            driverId:    driver.driverId,
            driverName:  driver.driverName,
            driverRating: driver.driverRating,
            driverPhoto: driver.driverPhoto,
            vehicle:     driver.vehicle,
            // Driver current location
            location: driverLat !== null && driverLng !== null
              ? { lat: driverLat, lng: driverLng }
              : null,
            // Google Maps distance & ETA
            distance:    parseFloat(distanceKm.toFixed(2)),
            eta:         etaMinutes,
          };
        }),
      );

      // Sort by distance ascending
      enriched.sort((a, b) => a.distance - b.distance);

      callback?.({
        success: true,
        message: 'Drivers found successfully.',
        data:    enriched,
      });
    } catch (error) {
      console.error('Error in getNearbyDriversHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  },
);