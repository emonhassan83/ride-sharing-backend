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

// Serves GET /notification (filter receiver, sort createdAt desc). Without it the
// list and its count each scanned the whole collection (load test: ~96k docs,
// avg 4-12 s per query under load, throughput capped at ~30 req/s).
notificationSchema.index({ receiver: 1, createdAt: -1, _id: -1 })

export const Notification = model<TNotification>(
  'Notification',
  notificationSchema,
)