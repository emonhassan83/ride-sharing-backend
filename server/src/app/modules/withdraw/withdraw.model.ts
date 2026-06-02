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
    booking: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    amount: { type: Number, required: true },
    stripeTransferId: { type: String },
    status: {
      type: String,
      enum: Object.values(WITHDRAW_STATUS),
      default: WITHDRAW_STATUS.proceed,
    },
    proceedAt: { type: Date },
  },
  {
    timestamps: true,
  },
)

export const Withdraw = model<TWithdraw, TWithdrawModel>(
  'Withdraw',
  withdrawSchema,
)
