import { Model, Types } from 'mongoose'
import { TChatStatus } from './chat.constants'

export interface TChat {
  _id?: Types.ObjectId
  booking: Types.ObjectId
  participants: Types.ObjectId[]
  status: TChatStatus
}

export type TChatModel = Model<TChat, Record<string, unknown>>
