// handlers/ride/getNearbyDrivers.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { User } from '../../../modules/user/user.model';
import { fetchDriversWithinRadius } from '../../../utils/geo.utils';
import { getRealDistanceAndETA } from '../../../utils/maps.utils';
import { TSocket } from '../../interface/index.interface';
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
      return callback?.({
        success: false,
        message: 'Pickup and destination required',
      });

    if (!departureDate || !departureTime)
      return callback?.({
        success: false,
        message: 'Departure date and time are required',
      });

    const redis = getRedisClient();
    // Keep seat eligibility identical to ride submission for all ride types.
    const requestedSeats = Number(passengers) > 0 ? Number(passengers) : 1;

    try {
      // ── Find nearby drivers (5km first, expand to 10km if none) ────────────
      let drivers = await fetchDriversWithinRadius(
        redis,
        pickup.lng,
        pickup.lat,
        5,
        rideType,
        requestedSeats,
        destination,
        departureDate,
        departureTime
      );

      if (drivers.length === 0) {
        drivers = await fetchDriversWithinRadius(
          redis,
          pickup.lng,
          pickup.lat,
          10,
          rideType,
          requestedSeats,
          destination,
          departureDate,
          departureTime
        );
      }

      if (drivers.length === 0) {
        return callback?.({
          success: true,
          message:
            'No drivers available within 10 km for the selected date and time.',
          data: [],
        });
      }

      // ── Enrich each driver with Google Maps distance/ETA + current location ─
      const enriched = await Promise.all(
        drivers.map(async (driver) => {
          let driverLat: number | null = null;
          let driverLng: number | null = null;

          // ── 1. Redis current (live) ─────────────────────────────────────────
          try {
            const currentRaw = await redis.get(
              `driver:${driver.driverId}:current`
            );
            if (currentRaw) {
              const current = JSON.parse(currentRaw);
              driverLat = current.lat;
              driverLng = current.lng;
            }
          } catch {
            /* ignore */
          }

          // ── 2. Fallback: DB last location ───────────────────────────────────
          if (driverLat === null || driverLng === null) {
            try {
              const dbUser = await User.findById(driver.driverId)
                .select('location')
                .lean();

              const coords = dbUser?.location?.coordinates;
              if (coords && coords[0] !== 0 && coords[1] !== 0) {
                driverLng = coords[0]; // [lng, lat]
                driverLat = coords[1];
                console.log(
                  `📍 Using DB location for driver ${driver.driverId}`
                );
              }
            } catch {
              /* ignore */
            }
          }

          // ── Google Maps ETA ─────────────────────────────────────────────────
          let distanceKm = driver.distance;
          let etaMinutes = Math.round((distanceKm / 30) * 60);

          if (driverLat !== null && driverLng !== null) {
            try {
              const result = await getRealDistanceAndETA(
                { lat: driverLat, lng: driverLng },
                { lat: pickup.lat, lng: pickup.lng }
              );
              distanceKm = result.distanceKm;
              etaMinutes = result.durationMinutes;
            } catch {
              /* keep fallback */
            }
          }

          return {
            driverId: driver.driverId,
            driverName: driver.driverName,
            driverEmail: driver.driverEmail,
            driverPhone: driver.driverPhone,
            driverPhoto: driver.driverPhoto,
            driverRating: driver.driverRating,
            vehicle: driver.vehicle,
            location:
              driverLat !== null && driverLng !== null
                ? { lat: driverLat, lng: driverLng }
                : null,
            distance: parseFloat(distanceKm.toFixed(2)),
            eta: etaMinutes,
            departureTime,
            departureDate,
          };
        })
      );
      // Sort by distance ascending
      enriched.sort((a, b) => a.distance - b.distance);

      callback?.({
        success: true,
        message: 'Drivers found successfully.',
        data: {
          pickup,
          destination,
          driverCount: enriched.length,
          drivers: enriched,
        },
      });
    } catch (error) {
      console.error('Error in getNearbyDriversHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);
