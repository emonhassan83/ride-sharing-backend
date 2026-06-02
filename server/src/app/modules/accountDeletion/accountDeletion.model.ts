import mongoose, { Schema } from 'mongoose';
import { IAccountDeletion, TAccountDeletionModel } from './accountDeletion.interface';

const accountDeletionSchema = new Schema<IAccountDeletion>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
    },
    reason: {
      type: String,
      required: [true, 'Deletion reason is required'],
    },
    otherReason: {
      type: String,
      trim: true,
      maxlength: 500,
    }
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Indexes
accountDeletionSchema.index({ user: 1 });
accountDeletionSchema.index({ reason: 1 });

export const AccountDeletion = mongoose.model<IAccountDeletion, TAccountDeletionModel>(
  'AccountDeletion',
  accountDeletionSchema
);