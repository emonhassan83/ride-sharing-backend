import { Model, Types } from 'mongoose'
import { TPaymentMethod, TPaymentStatus } from './payment.constant'

export type TPayment = {
  _id: string
  id: string
  user: Types.ObjectId
  provider?: Types.ObjectId | null
  booking: Types.ObjectId
  method: TPaymentMethod
  transactionId: string
  paymentIntentId: string
  providerEarning: number
  platformCommission: number
  amount: number
  status: TPaymentStatus
  isPaid: boolean
  isDeleted: boolean
  createdAt?: Date
  updatedAt?: Date
}

export type TPaymentModel = Model<TPayment>;
