import { Model, Types } from 'mongoose'

export interface TMessages {
  _id?: Types.ObjectId
  id?: string
  text?: string
  imageUrl?: string[]
  seen: boolean
  isEdited: boolean
  chat: Types.ObjectId
  sender: Types.ObjectId
  receiver: Types.ObjectId
  createdAt?: Date | number
  updatedAt?: Date | number
}

export type TMessagesModel = Model<TMessages, Record<string, unknown>>
