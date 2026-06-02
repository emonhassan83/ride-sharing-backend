import { Schema, Types, model } from 'mongoose'
import { modeType, TNotification } from './notification.interface'

const notificationSchema = new Schema<TNotification>(
  {
    receiver: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    reference: {
      type: Schema.Types.ObjectId,
      refPath: 'model_type',
    },
    model_type: {
      type: String,
      enum: Object.values(modeType),
    },
    message: {
      type: String,
      required: [true, 'Message is required'],
    },
    description: {
      type: String,
      default: '',
    },
    date: {
      type: Date,
      default: Date.now,
    },
    read: {
      type: Boolean,
      default: false,
    }
  },
  {
    timestamps: true,
  },
)

export const Notification = model<TNotification>(
  'Notification',
  notificationSchema,
)