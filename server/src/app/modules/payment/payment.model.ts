import { model, Schema } from 'mongoose'
import { TPayment } from './payment.interface'
import { generateCryptoString } from '../../utils/generateCryptoString'
import { PAYMENT_METHOD, PAYMENT_STATUS } from './payment.constant'

const paymentSchema = new Schema<TPayment>(
  {
    id: {
      type: String,
      unique: true,
      default: () => generateCryptoString(10),
    },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    booking: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    method: {
      type: String,
      enum: Object.values(PAYMENT_METHOD),
      required: true,
    },
    transactionId: { type: String, required: true },
    platformCommission: { type: Number, default: 0 },
    providerEarning: { type: Number, default: 0 },
    amount: { type: Number, min: 0 },
    authorizedAmount: { type: Number, min: 0, default: 0 },
    amountToCapture: { type: Number, min: 0, default: 0 },
    authorizationExpiresAt: { type: Date, default: null },
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.unpaid,
    },
    paymentIntentId: {
      type: String,
      default: null,
    },
    isPaid: {
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
  },
)

export const Payment = model<TPayment>('Payment', paymentSchema)
