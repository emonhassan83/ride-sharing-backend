// src/app/socket/handlers/chat/typing.handler.ts
import { TSocket } from '../../interface/socket.interface';
import eventHandler from '../../utils/eventHandler';
import { Chat } from '../../../modules/chat/chat.models';
import { User } from '../../../modules/user/user.model';
import { callbackFn } from '../../../utils/callbackFn';

export const typingHandler = eventHandler<any>(
  async (socket: TSocket, payload: any, callback: any) => {
    const { chatId } = payload;

    if (!chatId) {
      return callbackFn(callback, {
        success: false,
        message: 'chatId is required',
        data: null,
      });
    }

    const userId = socket.data?.user?._id?.toString() || socket.auth?._id?.toString();
    if (!userId) {
      return callbackFn(callback, {
        success: false,
        message: 'User not authenticated',
        data: null,
      });
    }

    try {
      // Find user name
      const user = await User.findById(userId).select('name').lean();
      const userName = user?.name || 'Unknown';

      // Find chat
      const chat = await Chat.findById(chatId);
      if (!chat) {
        return callbackFn(callback, {
          success: false,
          message: 'Chat not found',
          data: null,
        });
      }

      // Find chat others participant
      const otherUserId = chat.participants.find(
        (p: any) => p.toString() !== userId
      )?.toString();

      if (otherUserId) {
        // others user sent typing event
        socket.to(otherUserId).emit('typing', {
          success: true,
          message: `${userName} is typing...`,
          data: {
            chatId,
            userId,
            name: userName,
            isTyping: true,
            timestamp: new Date().toISOString(),
          },
        });
      }

      // sender send success message
      callbackFn(callback, {
        success: true,
        message: 'Typing status sent successfully',
        data: {
          chatId,
          receiverNotified: !!otherUserId,
        },
      });
    } catch (err: any) {
      console.error('❌ Typing handler error:', err.message);
      callbackFn(callback, {
        success: false,
        message: err.message || 'Internal server error',
        data: null,
      });
    }
  }
);