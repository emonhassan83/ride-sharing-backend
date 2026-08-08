import { Model, Types } from 'mongoose';
import { TRideStatus, TCancelledBy, TRideType } from './ride.constant';

export interface GeoLocation {
  lat: number;
  lng: number;
}

export interface NearbyDriver {
  driverId: string;
  distance: number;
  details: Record<string, string>;
}

export interface TRide {
  _id: Types.ObjectId;
  id: string;
  driverId: Types.ObjectId;
  vehicleId?: Types.ObjectId;
  rideCreatedBy: Types.ObjectId;
  notifiedDriverIds: Types.ObjectId[];
  type: TRideType;

  pickup: {
    address: string;
    coordinates: [number, number];
  };
  destination: {
    address: string;
    coordinates: [number, number];
  };

  departureTime: string;
  departureDate: string;

  totalSeats: number;
  bookedSeats: number;
  malePassengers: number;
  femalePassengers: number;
  
  routeGeometry?: {
    type: 'LineString';
    coordinates: number[][];
  };

  currentSurchargePercent: number
  splitFareLocked: boolean
  splitFareLockedAt?: Date
  splitFareLockReason?: 'departure_time' | 'trip_start'

  status: TRideStatus;
  cancellationReason: string;
  cancelledAt: Date;
  arrivedAt: Date;
  cancelledBy: TCancelledBy;
  reNotifiedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type TRideModel = Model<TRide>;
