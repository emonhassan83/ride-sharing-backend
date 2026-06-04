// handlers/ride/getNearbyDrivers.handler.ts
import { getRedisClient } from "../../../config/redis.config";
import { fetchDriversWithinRadius } from "../../../utils/geo.utils";
import { TSocket } from "../../interface/socket.interface";
import eventHandler from "../../utils/eventHandler";

export const getNearbyDriversHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { pickup, destination, rideType, passengers, departureDate, departureTime } = data;
    
    if (!pickup || !pickup.lat || !pickup.lng || !destination || !destination.lat || !destination.lng) {
      return callback?.({ success: false, message: 'Pickup and destination required' });
    }
    if (!departureDate || !departureTime) {
      return callback?.({ success: false, message: 'Departure date and time are required' });
    }

    const redis = getRedisClient();
    const pickupLat = pickup.lat;
    const pickupLng = pickup.lng;
    const requestedSeats = (rideType === 'split' && passengers && passengers > 0) ? passengers : 1;

    try {
      let drivers = await fetchDriversWithinRadius(
        redis, pickupLng, pickupLat, 5, rideType, requestedSeats, destination, departureDate, departureTime
      );

      if (drivers.length === 0) {
        drivers = await fetchDriversWithinRadius(
          redis, pickupLng, pickupLat, 10, rideType, requestedSeats, destination, departureDate, departureTime
        );
      }

      drivers = drivers.filter(driver => driver.distance <= 10);
      drivers.sort((a, b) => a.distance - b.distance);

      let filters: any = { rideType, departureDate, departureTime };
      if (rideType === 'split') filters.requestedSeats = requestedSeats;

      let radiusUsed = null;
      let message = 'Driver found successfully.';
      if (drivers.length === 0) {
        message = 'No drivers available within 10 km for the selected date and time. Please try different time.';
      } else {
        const maxDistanceInList = Math.max(...drivers.map(d => d.distance));
        radiusUsed = maxDistanceInList <= 5 ? 5 : 10;
      }

      callback?.({
        success: true,
        data: drivers,
        count: drivers.length,
        radiusUsed,
        filters,
        message,
      });
    } catch (error) {
      console.error('Error in getNearbyDriversHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);