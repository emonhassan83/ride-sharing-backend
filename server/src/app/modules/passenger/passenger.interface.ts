import { Model, Types } from 'mongoose';
import {
  TPassengerStatus,
  TCancelledBy,
  TFareType,
  TPaymentStatus,
} from './passenger.constant';

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

  // ── Fare fields ──────────────────────────────────────────────────────────
  initialCharge: number;
  perKmCharge: number;
  totalKmCharge: number;
  luggageCharge: number;
  holidayTripCharge: number;
  vat: number;
  estimatedFare: number;
  waitingCharge: number;
  fivePassengerCharge: number;
  sixPassengerCharge: number;
  totalFare: number;

  // ── Split fare tracking (new) ─────────────────────────────────────────────
  surchargePercent: number; // 0, 20, or 40
  surchargeAmount: number;
  paidAmount: number; // actually charged
  refundAmount: number; // total refunded so far

  // ── Payment status (new) ──────────────────────────────────────────────────
  paymentStatus: TPaymentStatus
  refundedToWallet: boolean,
  isNoShow: boolean,

  estimatedDistanceKm: number;
  estimatedDurationMinutes: number;
  luggageCounts: number;
  note?: string;

  status: TPassengerStatus;
  cancellationReason?: string;
  rejectionReason?: string;
  cancelledBy?: TCancelledBy;

  arriveAt: Date;
  arrivedNotified: boolean;
  pickedUpAt: Date;
  waitingStartedAt: Date; // in minute
  waitingChargePaid: boolean;
  droppedOffAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export type TPassengerModel = Model<TPassenger>;
