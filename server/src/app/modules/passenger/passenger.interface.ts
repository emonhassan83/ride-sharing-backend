import { Model, Types } from 'mongoose';
import { TPassengerStatus, TCancelledBy, TFareType } from './passenger.constant';

export interface TPassenger {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  rideId: Types.ObjectId;

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
  requestedSeats: number;
  malePassengers: number;
  femalePassengers: number;

  fareType: TFareType;
  initialCharge: number;
  perKmCharge: number;
  totalKmCharge: number;
  luggageCharge: number;
  holidayTripCharge: number;
  vat: number;
  estimatedFare: number;
  waitingCharge: number
  extraCharge: number
  estimatedDistanceKm: number;
  estimatedDurationMinutes: number;

  luggageCounts: number;
  note?: string;

  status: TPassengerStatus;

  cancellationReason?: string;
  rejectionReason?: string
  cancelledBy?: TCancelledBy;
  arriveAt: Date
  arrivedNotified: boolean
  pickedUpAt: Date
  waitingTime: number // in minute
  pickupOdometer: number
  droppedOffAt: Date
  dropOffOdometer: number

  createdAt: Date;
  updatedAt: Date;
}

export type TPassengerModel = Model<TPassenger>;