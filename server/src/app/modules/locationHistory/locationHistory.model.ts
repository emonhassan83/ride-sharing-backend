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

// Compound indexes for better query performance
locationHistorySchema.index({ driverId: 1, startTime: -1 });
locationHistorySchema.index({ userId: 1, startTime: -1 });
locationHistorySchema.index({ startTime: -1 }, { expireAfterSeconds: 7776000 }); // 90 days TTL

export const LocationHistory = mongoose.model<
  ILocationHistory,
  ILocationHistoryModel
>('LocationHistory', locationHistorySchema);
