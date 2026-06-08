import { Types } from 'mongoose';

export enum modeType {
  Auth = 'Auth',
  User = 'User',
  Provider = 'Provider',
  Ride = 'Ride',
  Payment = 'Payment',
  Withdraw = 'Withdraw',
  Refund = 'Refund',
}

export type TNotification = {
  receiver?: Types.ObjectId | string
  message: string
  description?: string
  reference?: Types.ObjectId | string
  modelType?: modeType
  date?: Date
  read?: boolean
  isDeleted?: boolean
}