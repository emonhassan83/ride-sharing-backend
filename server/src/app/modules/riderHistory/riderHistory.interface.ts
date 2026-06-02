import mongoose, { Document } from 'mongoose';
import { TRideHistoryPaymentStatus, TRideHistoryStatus } from './riderHistory.constant';

export interface IRiderHistory extends Document {
  userId: mongoose.Types.ObjectId;
  rideId: mongoose.Types.ObjectId;
  summary: {
    pickupAddress: string;
    pickupCoordinates: [number, number];
    destinationAddress: string;
    destinationCoordinates: [number, number];
    date: Date;
    fare: number;
    distance: number;
    duration: number;
    rideType: string;
  };
  driver: {
    driverId: mongoose.Types.ObjectId;
    driverName: string;
    driverPhone: string;
    driverPhoto?: string;
    carModel: string;
    carNumber: string;
  };
  paymentStatus: TRideHistoryPaymentStatus;
  status: TRideHistoryStatus;
  cancellationReason?: string;
  createdAt: Date;
}