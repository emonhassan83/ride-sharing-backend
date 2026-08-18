import { Schema, model } from 'mongoose';
import { TRefund, TRefundModel } from './refund.interface';
import { REFUND_STATUS, REFUND_TYPE } from './refund.constant';
import { generateCryptoString } from '../../utils/generateCryptoString';

const refundSchema = new Schema<TRefund>(
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
    ride: {
      type: Schema.Types.ObjectId,
      ref: 'Ride',
      default: null,
    },
    type: {
      type: String,
      enum: Object.values(REFUND_TYPE)
    },
    paymentIntentId: { type: String },
    amount: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true },
    note: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(REFUND_STATUS),
      default: REFUND_STATUS.pending,
    },
    processedAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

export const Refund = model<TRefund, TRefundModel>('Refund', refundSchema);

