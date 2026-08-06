import { Schema, model } from 'mongoose'
import { TWithdraw, TWithdrawModel } from './withdraw.interface'
import { WITHDRAW_STATUS } from './withdraw.constant'
import { PROVIDER_TYPE } from '../user/user.constant'
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
    stripeTransferId: { type: String },
    ibanNumber: { type: String, trim: true, default: null },
    providerType: {
      type: String,
      enum: Object.values(PROVIDER_TYPE),
      default: null,
    },
    manualTransferReference: { type: String, trim: true, default: null },
    status: {
      type: String,
      enum: Object.values(WITHDRAW_STATUS),
      default: WITHDRAW_STATUS.pending,
    },
    proceedAt:   { type: Date, default: null },
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

