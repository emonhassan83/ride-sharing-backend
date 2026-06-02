import mongoose, { Schema } from 'mongoose';
import { IRiderHistory } from './riderHistory.interface';
import { RIDE_HISTORY_PAYMENT_STATUS, RIDE_HISTORY_STATUS } from './riderHistory.constant';

const riderHistorySchema = new Schema<IRiderHistory>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    rideId: {
      type: Schema.Types.ObjectId,
      ref: 'Ride',
      required: true,
      unique: true,
    },
    summary: {
      pickupAddress: { type: String, required: true },
      pickupCoordinates: { type: [Number], required: true, index: '2dsphere' },
      destinationAddress: { type: String, required: true },
      destinationCoordinates: { type: [Number], required: true },
      date: { type: Date, required: true, index: true },
      fare: { type: Number, required: true, min: 0 },
      distance: { type: Number, required: true, min: 0 },
      duration: { type: Number, required: true, min: 0 },
      rideType: { type: String, required: true },
    },
    driver: {
      driverId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      driverName: { type: String, required: true },
      driverPhone: { type: String, required: true },
      driverPhoto: String,
      carModel: { type: String, required: true },
      carNumber: { type: String, required: true },
      carColor: String,
    },
    paymentStatus: {
      type: String,
      enum: Object.values(RIDE_HISTORY_PAYMENT_STATUS),
      default: RIDE_HISTORY_PAYMENT_STATUS.pending,
    },
    status: {
      type: String,
      enum: Object.values(RIDE_HISTORY_STATUS),
      required: true
    },
    cancellationReason: String,
  },
  {
    timestamps: true,
  }
);

// Indexes for common queries
riderHistorySchema.index({ userId: 1, 'summary.date': -1 });
riderHistorySchema.index({ userId: 1, status: 1 });
riderHistorySchema.index({ 'summary.date': -1 });

export const RiderHistory = mongoose.model<IRiderHistory>(
  'RiderHistory',
  riderHistorySchema
);
