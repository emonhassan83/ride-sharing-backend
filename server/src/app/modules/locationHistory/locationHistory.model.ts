import mongoose, { Schema } from 'mongoose';
import {
  ILocationHistory,
  ILocationHistoryModel,
  ILocationPoint,
} from './locationHistory.interface';

const locationPointSchema = new Schema<ILocationPoint>({
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  speed: { type: Number, default: 0 },
  heading: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now },
  event: {
    type: String,
    enum: ['TRIP_STARTED', 'ARRIVED_AT_PICKUP', 'WAYPOINT', 'PASSENGER_DROPPED_OFF'],
  },
});

const locationHistorySchema = new Schema<ILocationHistory>(
  {
    rideId: {
      type: Schema.Types.ObjectId,
      ref: 'Ride',
      required: true,
      index: true,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    passengerIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    locations: [locationPointSchema],
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    totalDistance: { type: Number, required: true, min: 0 },
    totalDuration: { type: Number, required: true, min: 0 },
    averageSpeed: { type: Number, required: true, min: 0 },
    maxSpeed: { type: Number, required: true, min: 0 },
  },
  {
    timestamps: true,
  }
);

// ==================== INDEXES ====================

// Performance indexes
locationHistorySchema.index({ driverId: 1, startTime: -1 });
locationHistorySchema.index({ rideId: 1, startTime: -1 });
locationHistorySchema.index({ passengerIds: 1 });

// ==================== TTL INDEX (30 Days) ====================
locationHistorySchema.index(
  { startTime: 1 }, 
  { 
    expireAfterSeconds: 30 * 24 * 60 * 60, // 30 days in seconds
    name: 'location_history_ttl_30days' 
  }
);

export const LocationHistory = mongoose.model<
  ILocationHistory,
  ILocationHistoryModel
>('LocationHistory', locationHistorySchema);