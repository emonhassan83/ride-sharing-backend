import mongoose, { Schema } from 'mongoose';
import { TProvider, TProviderModel } from './provider.interface';
import { PROVIDER_STATUS } from './provider.constant';

const providerSchema = new Schema<TProvider>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      unique: true, // one provider profile per user
    },
    companyName: {
      type: String,
      trim: true,
      default: null,
    },
    companyReg: {
      type: String,
      trim: true,
      default: null,
    },
    vatNumber: {
      type: String,
      required: [true, 'VAT number is required'],
      trim: true,
    },
    ibanNumber: {
      type: String,
      required: [true, 'IBAN number is required'],
      trim: true,
    },
    cnicFront: {
      type: String,
      required: [true, 'CNIC front image is required'],
      trim: true,
    },
    cnicBack: {
      type: String,
      required: [true, 'CNIC back image is required'],
      trim: true,
    },
    licenseFront: {
      type: String,
      required: [true, 'License front image is required'],
      trim: true,
    },
    licenseBack: {
      type: String,
      required: [true, 'License back image is required'],
      trim: true,
    },
    carPapers: {
      type: [String],
      required: [true, 'Car papers are required'],
      validate: {
        validator: (v: string[]) => v.length >= 1 && v.length <= 10,
        message: 'Car papers must have between 1 and 10 documents',
      },
    },
    status: {
      type: String,
      enum: {
        values: Object.values(PROVIDER_STATUS),
        message: 'Invalid approval status',
      },
      default: PROVIDER_STATUS.pending,
    },
    rejectionReason: {
      type: String,
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Indexes
providerSchema.index({ approvalStatus: 1 });

// Virtual populate user
providerSchema.virtual('user', {
  ref: 'User',
  localField: 'userId',
  foreignField: '_id',
  justOne: true,
});

export const Provider = mongoose.model<TProvider, TProviderModel>('Provider', providerSchema);


