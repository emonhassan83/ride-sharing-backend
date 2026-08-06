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

export const Withdraw = model<TWithdraw, TWithdrawModel>(
  'Withdraw',
  withdrawSchema,
)

