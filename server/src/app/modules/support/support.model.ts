import mongoose, { Schema } from 'mongoose';
import { TSupport, TSupportModel } from './support.interface';
import { CONTRACT_BY, SUPPORT_STATUS } from './support.constant';
import { generateCryptoString } from '../../utils/generateCryptoString';

const supportSchema = new Schema<TSupport>(
  {
    id: {
      type: String,
      unique: true,
      default: () => generateCryptoString(10),
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
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
      default: SUPPORT_STATUS.pending,
    },
    contractBy: {
      type: String,
      enum: Object.values(CONTRACT_BY)
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

export const Support = mongoose.model<TSupport, TSupportModel>(
  'Support',
  supportSchema
);
