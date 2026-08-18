import mongoose, { Schema } from 'mongoose';
import { TPassenger, TPassengerModel } from './passenger.interface';
import {
  FARE_TYPE,
  PASSENGER_STATUS,
  CANCELLED_BY,
  PAYMENT_STATUS,
} from './passenger.constant';

const passengerSchema = new Schema<TPassenger>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
    },
    rideId: {
      type: Schema.Types.ObjectId,
      ref: 'Ride',
      default: null,
    },

    pickup: {
      address: { type: String, required: true },
      coordinates: {
        type: [Number],
        required: true,
        index: '2dsphere',
      },
    },
    destination: {
      address: { type: String, required: true },
      coordinates: {
        type: [Number],
        required: true,
      },
    },

    departureDate: { type: String, required: true },
    departureTime: { type: String, required: true },
    requestedSeats: { type: Number, required: true, min: 1 },
    malePassengers: { type: Number, default: 0, required: true },
    femalePassengers: { type: Number, default: 0, required: true },

    fareType: {
      type: String,
      enum: Object.values(FARE_TYPE),
      required: true,
    },

    // ── Fare fields ──────────────────────────────────────────────────────────
    initialCharge: { type: Number, default: 0 },
    perKmCharge: { type: Number, default: 0 },
    totalKmCharge: { type: Number, default: 0 },
    luggageCharge: { type: Number, default: 0 },
    holidayTripCharge: { type: Number, default: 0 },
    vat: { type: Number, default: 0 },
    estimatedFare: { type: Number, default: 0 },
    waitingCharge: { type: Number, default: 0 },
    fivePassengerCharge: { type: Number, default: 0 },
    sixPassengerCharge: { type: Number, default: 0 },
    totalFare: { type: Number, default: 0 },

    // ── Split fare tracking (new) ─────────────────────────────────────────────
    surchargePercent: { type: Number, default: 0 }, // 0, 20, or 40
    surchargeAmount: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 }, // actually charged
    refundAmount: { type: Number, default: 0 }, // total refunded so far

    // ── Payment status (new) ──────────────────────────────────────────────────
    paymentStatus: {
      type: String,
     enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.pending,
    },
    refundedToWallet: { type: Boolean, default: false },
    isNoShow: { type: Boolean, default: false },

    estimatedDistanceKm: { type: Number, default: 0 },
    estimatedDurationMinutes: { type: Number, default: 0 },
    luggageCounts: { type: Number, default: 0 },
    note: { type: String },

    status: {
      type: String,
      enum: Object.values(PASSENGER_STATUS),
      default: PASSENGER_STATUS.pending,
    },

    cancellationReason: { type: String },
    rejectionReason: { type: String },
    cancelledBy: {
      type: String,
      enum: Object.values(CANCELLED_BY),
    },

    // ── Trip tracking ─────────────────────────────────────────────────────────
    arriveAt:          { type: Date },
    arrivedNotified:   { type: Boolean, default: false },
    pickedUpAt:        { type: Date },
    waitingStartedAt:  { type: Date,    default: null },
    waitingChargePaid: { type: Boolean, default: false },
    droppedOffAt:      { type: Date },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Indexes for performance
passengerSchema.index({ userId: 1, status: 1 });
passengerSchema.index({ rideId: 1, status: 1 });

export const Passenger = mongoose.model<TPassenger, TPassengerModel>(
  'Passenger',
  passengerSchema
);

