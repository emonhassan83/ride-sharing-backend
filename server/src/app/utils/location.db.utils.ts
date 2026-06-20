// utils/location.db.utils.ts
import { LocationHistory } from '../modules/locationHistory/locationHistory.model';
import { Ride } from '../modules/ride/ride.model';
import { Passenger } from '../modules/passenger/passenger.model';
import { calculateTotalDistance, calculateDuration } from './location.utils';

export async function saveLocationsToDatabase(
  rideId:    string,
  locations: any[],
  driverId:  string,
) {
  try {
    const ride = await Ride.findById(rideId);
    if (!ride) return;

    const passengers = await Passenger.find({ rideId });

    // ✅ Filter: শুধু valid lat/lng আছে এমন entries রাখো
    // Redis live list এ ARRIVED_AT_PICKUP, TRIP_STARTED ইত্যাদি events আছে
    // যেগুলোতে lat/lng নাও থাকতে পারে
    const parsedLocations = locations
      .map(loc => {
        // loc JSON string হতে পারে বা already parsed
        const parsed = typeof loc === 'string' ? JSON.parse(loc) : loc;
        return parsed;
      })
      .filter(loc => {
        const lat = parseFloat(loc.lat);
        const lng = parseFloat(loc.lng);
        // ✅ NaN, undefined, null, 0,0 filter out
        return (
          loc.lat != null &&
          loc.lng != null &&
          !isNaN(lat) &&
          !isNaN(lng) &&
          !(lat === 0 && lng === 0)
        );
      })
      .map(loc => ({
        lat:       parseFloat(loc.lat),
        lng:       parseFloat(loc.lng),
        speed:     parseFloat(loc.speed)   || 0,
        heading:   parseFloat(loc.heading) || 0,
        timestamp: loc.timestamp ? new Date(loc.timestamp) : new Date(),
        event:     loc.event || 'WAYPOINT',
      }));

    // ✅ Location points না থাকলে skip
    if (!parsedLocations.length) {
      console.warn(`⚠️ No valid location points for ride ${rideId} — skipping history save`);
      return;
    }

    // ✅ NaN guard on calculations
    const totalDistance = calculateTotalDistance(parsedLocations) || 0;
    const totalDuration = calculateDuration(parsedLocations)     || 0;

    const avgSpeed = (totalDuration > 0 && totalDistance > 0)
      ? Math.round((totalDistance / (totalDuration / 3600)) * 100) / 100
      : 0;

    const maxSpeed = parsedLocations.length
      ? Math.max(...parsedLocations.map(l => l.speed || 0))
      : 0;

    // ✅ Final NaN check before DB insert
    if (isNaN(totalDistance) || isNaN(avgSpeed) || isNaN(maxSpeed)) {
      console.warn(`⚠️ Calculated NaN values for ride ${rideId} — using 0 fallbacks`);
    }

    const existing = await LocationHistory.findOne({ rideId });
    if (existing) {
      console.log(`⚠️ LocationHistory already exists for ride ${rideId} — skipping`);
      return;
    }

    const passengerIds = passengers.map(p => p.userId);

    await LocationHistory.create({
      rideId,
      driverId,
      passengerIds,
      locations:     parsedLocations,
      startTime:     parsedLocations[0].timestamp,
      endTime:       parsedLocations[parsedLocations.length - 1].timestamp,
      totalDistance: isNaN(totalDistance) ? 0 : totalDistance,
      totalDuration: isNaN(totalDuration) ? 0 : totalDuration,
      averageSpeed:  isNaN(avgSpeed)      ? 0 : avgSpeed,
      maxSpeed:      isNaN(maxSpeed)      ? 0 : maxSpeed,
    });

    console.log(`✅ Location history saved | ride: ${rideId} | points: ${parsedLocations.length} | passengers: ${passengers.length}`);
  } catch (error) {
    console.error(`❌ saveLocationsToDatabase failed for ride ${rideId}:`, error);
  }
}