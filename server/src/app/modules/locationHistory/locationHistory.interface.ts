import { Model, Types } from "mongoose";

export interface ILocationPoint {
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  timestamp: Date;
  event?: 'TRIP_STARTED' | 'ARRIVED_AT_PICKUP' | 'WAYPOINT';
}

export interface ILocationHistory extends Document {
  rideId: Types.ObjectId;
  driverId: Types.ObjectId;
  passengerIds: Types.ObjectId[];
  locations: ILocationPoint[];
  startTime: Date;
  endTime: Date;
  totalDistance: number; // in km
  totalDuration: number; // in seconds
  averageSpeed: number; // km/h
  maxSpeed: number; // km/h
  createdAt: Date;
}

export type ILocationHistoryModel = Model<ILocationHistory, Record<string, unknown>>