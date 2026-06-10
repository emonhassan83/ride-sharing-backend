import mongoose, { Schema } from 'mongoose';
import { TRide, TRideModel } from './ride.interface';
import { CANCELLED_BY, RIDE_STATUS, RIDE_TYPE } from './ride.constant';
import { generateCryptoString } from '../../utils/generateCryptoString';

const rideSchema = new Schema<TRide>(
  {
    id: {
      type: String,
      unique: true,
      default: () => generateCryptoString(10),
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: 'Vehicle',
      required: false,
    },
    rideCreatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: Object.values(RIDE_TYPE),
      required: true,
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

    // Route geometry (GeoJSON LineString)
    routeGeometry: {
      type: {
        type: String,
        enum: ['LineString'],
        default: 'LineString',
      },
      coordinates: {
        type: [[Number]], // array of [[lng, lat], [lng, lat], ...]
        required: false,
      },
    },

    totalSeats: { type: Number, required: true, min: 1 },
    bookedSeats: { type: Number, default: 0 },
    malePassengers: { type: Number, default: 0, required: true },
    femalePassengers: { type: Number, default: 0, required: true },

    status: {
      type: String,
      enum: Object.values(RIDE_STATUS),
      default: RIDE_STATUS.pending,
    },
    cancellationReason: { type: String },
    cancelledAt: { type: Date },
    arrivedAt: { type: Date },
    cancelledBy: {
      type: String,
      enum: Object.values(CANCELLED_BY),
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Indexes
rideSchema.index({ driverId: 1, status: 1 });
rideSchema.index({ departureDate: 1, departureTime: 1, status: 1 });
rideSchema.index({ status: 1, createdAt: 1 });
rideSchema.index({ status: 1, arrivedAt: 1 });

export const Ride = mongoose.model<TRide, TRideModel>('Ride', rideSchema);
