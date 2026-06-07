import mongoose, { Schema } from 'mongoose';
import { TPassenger, TPassengerModel } from './passenger.interface';
import {
  FARE_TYPE,
  PASSENGER_STATUS,
  CANCELLED_BY,
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
      required: [true, 'Ride ID is required'],
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
    initialCharge: { type: Number, default: 0 },
    perKmCharge: { type: Number, default: 0 },
    totalKmCharge: { type: Number, default: 0 },
    luggageCharge: { type: Number, default: 0 },
    holidayTripCharge: { type: Number, default: 0 },
    vat: { type: Number, default: 0 },
    estimatedFare: { type: Number, default: 0 },
    waitingCharge: { type: Number, default: 0 },
    extraCharge: { type: Number, default: 0 },
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

    arriveAt: { type: Date },
    arrivedNotified: { type: Boolean, default: false },
    pickedUpAt: { type: Date },
    waitingTime: { type: Number },
    pickupOdometer: { type: Number },
    droppedOffAt: { type: Date },
    dropOffOdometer: { type: Number },
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
