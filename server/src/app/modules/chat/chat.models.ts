import { Schema, model } from 'mongoose';
import { TChat, TChatModel } from './chat.interface';
import { CHAT_STATUS } from './chat.constants';

const chatSchema = new Schema<TChat>(
  {
    booking: {
      type: Schema.Types.ObjectId,
      ref: 'Booking',
      unique: true,
    },
    participants: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    status: {
      type: String,
      enum: Object.values(CHAT_STATUS),
      default: CHAT_STATUS.accepted,
    },
  },
  { timestamps: true }
);

chatSchema.index({ participants: 1 });

export const Chat = model<TChat, TChatModel>('Chat', chatSchema);
