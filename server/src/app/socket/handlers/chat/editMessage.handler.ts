// src/app/socket/handlers/chat/editMessage.handler.ts
import { Message } from '../../../modules/messages/messages.model';
import { callbackFn } from '../../../utils/callbackFn';
import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';

export const editMessageHandler = eventHandler(
  async (socket: TSocket, { messageId, payload }: any, callback: any) => {
    const userId = socket.auth._id.toString();

    try {
      // 1. Find message
      const message = await Message.findById(messageId);
      if (!message) {
        return callbackFn(callback, { success: false, message: 'Message not found' });
      }

      // 2. only edit message sender
      if (message.sender.toString() !== userId) {
        return callbackFn(callback, { success: false, message: 'Unauthorized to edit!' });
      }

      // 3. Field update based on text
      if (payload.text !== undefined) {
        message.text = payload.text;
      }
      if (payload.imageUrl !== undefined) {
        message.imageUrl = payload.imageUrl;
      }
      message.isEdited = true;
      await message.save();

      // 4. populated message
      const populated = await Message.findById(message._id)
        .populate('sender', 'name profileImage _id')
        .populate('receiver', 'name profileImage _id');

      socket.emit('message-updated', populated);
      socket.to(message.receiver.toString()).emit('message-updated', populated);

      callbackFn(callback, {
        success: true,
        message: 'Message edited successfully',
        populated,
      });
    } catch (err: any) {
      console.error('❌ Edit message error:', err.message);
      callbackFn(callback, { success: false, message: err.message });
    }
  }
);