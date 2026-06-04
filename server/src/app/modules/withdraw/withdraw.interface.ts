import { Model, Types } from 'mongoose'
import { TWithdrawStatus } from './withdraw.constant'

export type TWithdraw = {
  _id?: string
  id: string
  user: Types.ObjectId
  booking: Types.ObjectId
  amount: number
  stripeTransferId?: string
  status: TWithdrawStatus
  proceedAt?: Date
  completedAt?: Date
  note?: String
  createdAt?: Date
}

export type TWithdrawModel = Model<TWithdraw, Record<string, unknown>>
