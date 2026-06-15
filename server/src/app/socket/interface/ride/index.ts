export interface ILatLng {
  lat: number;
  lng: number;
}

// driver availability check Interface
export interface IDriverAvailability {
  available: boolean; // true if driver can be shown to passenger
  rideId?: string; // if joining an existing split ride, the ride ID
  reason?: string; // optional debug info
}

//  Interface
export interface IRealDistanceAndETA {
  distanceKm: number;
  durationMinutes: number;
}

//  Interface
export interface ICalculateETAForRide {
  etaMinutes: number;
  distanceKm: number;
}

// Route geometry Interface
export interface IRouteGeometry {
  type: 'LineString';
  coordinates: number[][];
}

// Split ride request interface
export interface ISplitRideRequest {
  pickup: { lat: number; lng: number; address?: string };
  destination: { lat: number; lng: number; address?: string };
  departureDate: string; // ISO date string
  departureTime: string; // ISO time string
  passengers: number;
}
