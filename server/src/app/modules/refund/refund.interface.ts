import { Model, Types } from 'mongoose'
import { TRefundStatus } from './refund.constant'

export type TRefund = {
  _id?: string
  id: string
  user: Types.ObjectId | string
  order: Types.ObjectId | string
  paymentIntentId: string
  amount: number
  reason: string
  note: string
  status: TRefundStatus
  processedAt: Date
}

export type TRefundModel = Model<TRefund, Record<string, unknown>>
