import { Model, Types } from 'mongoose'
import { TWithdrawStatus } from './withdraw.constant'

export type TWithdraw = {
  _id?: string
  id: string
  user: Types.ObjectId
  booking: Types.ObjectId
  amount: number
  ibanNumber?: string
  status: TWithdrawStatus
  completedAt?: Date
  note?: string
  createdAt?: Date
}

export type TWithdrawModel = Model<TWithdraw, Record<string, unknown>>

