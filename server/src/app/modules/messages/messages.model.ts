import { Schema, Types, model } from 'mongoose'
import { TMessages, TMessagesModel } from './messages.interface'

const messageSchema = new Schema<TMessages>(
  {
    text: {
      type: String,
      default: null,
    },
    imageUrl: {
      type: [String],
      default: [],
    },
    seen: {
      type: Boolean,
      default: false,
    },
    isEdited: {
      type: Boolean,
      default: false,
    },
    sender: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'User',
    },
    receiver: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'User',
    },

    chat: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'Chat',
    },
  },
  {
    timestamps: true,
  },
)

export const Message = model<TMessages, TMessagesModel>(
  'Messages',
  messageSchema,
)
