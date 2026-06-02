import mongoose, { Schema } from 'mongoose';
import { TSupport, TSupportModel } from './support.interface';
import { SUPPORT_STATUS } from './support.constant';

const supportSchema = new Schema<TSupport>(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
    },
    booking: {
      type: Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },
    reason: {
      type: String,
      required: [true, 'Reason is required'],
      trim: true,
      minlength: [10, 'Reason must be at least 10 characters long'],
    },
    status: {
      type: String,
      enum: Object.values(SUPPORT_STATUS),
      default: 'pending',
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Indexes for better performance
supportSchema.index({ jobId: 1 });
supportSchema.index({ status: 1 });
supportSchema.index({ phone: 1 });

export const Support = mongoose.model<TSupport, TSupportModel>('Support', supportSchema);