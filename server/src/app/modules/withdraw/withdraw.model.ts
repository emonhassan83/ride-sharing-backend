import { Schema, model } from 'mongoose'
import { TWithdraw, TWithdrawModel } from './withdraw.interface'
import { WITHDRAW_STATUS } from './withdraw.constant'
import { generateCryptoString } from '../../utils/generateCryptoString'

const withdrawSchema = new Schema<TWithdraw>(
  {
    id: {
      type: String,
      unique: true,
      default: () => generateCryptoString(10),
    },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ride: { type: Schema.Types.ObjectId, ref: 'Ride', default: null },
    booking: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
    payment: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    amount: { type: Number, required: true },
    ibanNumber: { type: String, trim: true, default: null },
    status: {
      type: String,
      enum: Object.values(WITHDRAW_STATUS),
      default: WITHDRAW_STATUS.pending,
    },
    completedAt: { type: Date, default: null },
    note:        { type: String, default: null },
  },
  {
    timestamps: true,
  },
)

withdrawSchema.index({ payment: 1 }, { unique: true, sparse: true });
withdrawSchema.index({ user: 1, ride: 1 });
withdrawSchema.index({ user: 1, status: 1, createdAt: -1 });

export const Withdraw = model<TWithdraw, TWithdrawModel>(
  'Withdraw',
  withdrawSchema,
)


