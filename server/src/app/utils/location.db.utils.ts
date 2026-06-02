// utils/location.db.utils.ts
import { LocationHistory } from '../modules/locationHistory/locationHistory.model';
import { Ride } from '../modules/ride/ride.model';
import { Passenger } from '../modules/passenger/passenger.model';
import { calculateTotalDistance, calculateDuration } from './location.utils';

/**
 * Save location history to database (called when trip completes)
 */
export async function saveLocationsToDatabase(rideId: string, locations: any[], driverId: string) {
  const ride = await Ride.findById(rideId);
  if (!ride) return;
  
  // Get all passengers for this ride
  const passengers = await Passenger.find({ rideId });
  
  const parsedLocations = locations.map(loc => ({
    lat: loc.lat, 
    lng: loc.lng, 
    speed: loc.speed || 0, 
    heading: loc.heading || 0,
    timestamp: new Date(loc.timestamp), 
    event: loc.event || 'WAYPOINT'
  }));
  
  const totalDistance = calculateTotalDistance(parsedLocations);
  const totalDuration = calculateDuration(parsedLocations);
  const avgSpeed = totalDuration > 0 ? (totalDistance / (totalDuration / 3600)) : 0;
  const maxSpeed = Math.max(...parsedLocations.map(l => l.speed || 0), 0);
  
  const existing = await LocationHistory.findOne({ rideId });
  
  if (!existing) {
    // For split ride with multiple passengers, store passengerIds array
    const passengerIds = passengers.map(p => p.userId);
    
    await LocationHistory.create({
      rideId, 
      driverId, 
      passengerIds,  // ✅ array of passenger user IDs
      locations: parsedLocations,
      startTime: parsedLocations[0]?.timestamp || new Date(),
      endTime: parsedLocations[parsedLocations.length-1]?.timestamp || new Date(),
      totalDistance, 
      totalDuration, 
      averageSpeed: avgSpeed, 
      maxSpeed
    });
    
    console.log(`✅ Saved location history for ride ${rideId} with ${passengers.length} passengers`);
  }
}