import { Model, Types } from 'mongoose'
import { TWithdrawStatus } from './withdraw.constant'
import { TProviderType } from '../user/user.constant'

export type TWithdraw = {
  _id?: string
  id: string
  user: Types.ObjectId
  booking: Types.ObjectId
  amount: number
  stripeTransferId?: string
  ibanNumber?: string
  providerType?: TProviderType
  manualTransferReference?: string
  status: TWithdrawStatus
  proceedAt?: Date
  completedAt?: Date
  note?: string
  createdAt?: Date
}

export type TWithdrawModel = Model<TWithdraw, Record<string, unknown>>

