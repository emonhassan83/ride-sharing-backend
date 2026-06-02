import { Model, Types } from 'mongoose';
import { TBookingStatus, TPaymentStatus } from './booking.constant';

export interface TBooking {
  _id: Types.ObjectId;
  id: string
  passengerId: Types.ObjectId; 
  rideId: Types.ObjectId; 
  userId: Types.ObjectId;
  driverId: Types.ObjectId;          // Kept (for quick access & indexing)

  totalFare: number;                 // Most important
  amountPaid: number;

  bookingStatus: TBookingStatus;
  paymentStatus: TPaymentStatus;

  transactionId?: string;            // Stripe Payment Intent ID
  refundAmount?: number;

  createdAt: Date;
  updatedAt: Date;
}

export type TBookingModel = Model<TBooking>;