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
      refPath: 'modelType',
    },
    modelType: {
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
    },
    // B-14: deep-link info, the same string map that is sent in FCM `data`
    // (type, rideId, passengerId, bookingId, chatId, screen, ...).
    type: {
      type: String,
      default: null,
    },
    data: {
      type: Map,
      of: String,
      default: {},
    },
  },
  {
    timestamps: true,
  },
)

export const Notification = model<TNotification>(
  'Notification',
  notificationSchema,
)