import mongoose, { Schema } from 'mongoose';
import { TVehicle } from './vehicle.interface';

const vehicleSchema = new Schema<TVehicle>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
    },
    name: {
      type: String,
      required: [true, 'Vehicle name is required'],
      trim: true,
    },
    number: {
      type: String,
      required: [true, 'Vehicle number is required'],
      unique: true,
      trim: true,
      uppercase: true,
    },
    year: {
      type: Number,
      required: [true, 'Manufacturing year is required'],
      min: [1900, 'Year must be valid'],
      max: [new Date().getFullYear() + 1, 'Year cannot be in the future'],
    },
    seats: {
      type: Number,
      required: [true, 'Number of seats is required'],
      min: [4, 'At least 4 seat required'],
      max: [6, 'Maximum 6 seats allowed'],
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Indexes
vehicleSchema.index({ userId: 1, isDeleted: 1 });
vehicleSchema.index({ number: 1 }, { unique: true });

// Soft delete middleware
vehicleSchema.pre(/^find/, function (next) {
  // @ts-ignore
  this.where({ isDeleted: false });
  next();
});

export const Vehicle = mongoose.model<TVehicle>('Vehicle', vehicleSchema);