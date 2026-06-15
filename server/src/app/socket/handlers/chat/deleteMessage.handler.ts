// src/app/socket/handlers/chat/deleteMessage.handler.ts
import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';
import { Message } from '../../../modules/messages/messages.model';
import { callbackFn } from '../../../utils/callbackFn';
import { getIO } from '../../socket.init';

export const deleteMessageHandler = eventHandler(
  async (socket: TSocket, payload: any, callback: any) => {
    const { messageId } = payload;
    const userId = socket.auth._id.toString();

    // validation
    if (!messageId) {
      return callbackFn(callback, {
        success: false,
        message: 'messageId is required',
        data: null,
      });
    }

    try {
      const message = await Message.findById(messageId);
      if (!message) {
        return callbackFn(callback, {
          success: false,
          message: 'Message not found',
          data: null,
        });
      }

      // only sender can delete message
      if (message.sender.toString() !== userId) {
        return callbackFn(callback, {
          success: false,
          message: 'Unauthorized to delete this message',
          data: null,
        });
      }

      // message delete
      await Message.findByIdAndDelete(messageId);

      // delete message data
      const deleteData = {
        messageId: message._id.toString(),
        chatId: message.chat?.toString(),
        deletedAt: new Date().toISOString(),
        deletedBy: userId,
      };

      // 1. sent notification to sender
      socket.emit('message-deleted', {
        success: true,
        message: 'Message deleted successfully',
        data: deleteData,
      });

      // 2. receiver sent notification
      socket
        .to(message.receiver.toString())
        .emit('message-deleted', {
          success: true,
          message: 'A message was deleted',
          data: deleteData,
        });

      // sender response callback
      callbackFn(callback, {
        success: true,
        message: 'Message deleted successfully',
        data: {
          messageId: message._id.toString(),
          deletedAt: new Date().toISOString(),
        },
      });
    } catch (err: any) {
      console.error('❌ Delete message error:', err.message);
      callbackFn(callback, {
        success: false,
        message: err.message || 'Internal server error',
        data: null,
      });
    }
  }
);
