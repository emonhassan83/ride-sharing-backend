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
  driverId: Types.ObjectId;
  vehicleId?: Types.ObjectId;
  rideCreatedBy: Types.ObjectId;
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
  startOdometer: number;
  endOdometer: number;
  routeGeometry?: {
    type: 'LineString';
    coordinates: number[][];
  };

  status: TRideStatus;
  cancellationReason: string;
  cancelledAt: Date;
  arrivedAt: Date;
  cancelledBy: TCancelledBy;

  createdAt: Date;
  updatedAt: Date;
}

export type TRideModel = Model<TRide>;
