// src/app/socket/handlers/chat/stopTyping.handler.ts
import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';
import { Chat } from '../../../modules/chat/chat.models';
import { User } from '../../../modules/user/user.model';
import { callbackFn } from '../../../utils/callbackFn';

export const stopTypingHandler = eventHandler<any>(
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
      // Find user
      const user = await User.findById(userId).select('name').lean();
      const userName = user?.name || 'Unknown';

      const chat = await Chat.findById(chatId);
      if (!chat) {
        return callbackFn(callback, {
          success: false,
          message: 'Chat not found',
          data: null,
        });
      }

      const otherUserId = chat.participants
        .find((p: any) => p.toString() !== userId)
        ?.toString();

      if (otherUserId) {
        // other user sent stop typing event
        socket.to(otherUserId).emit('stopTyping', {
          success: true,
          message: `${userName} stopped typing`,
          data: {
            chatId,
            userId,
            name: userName,
            isTyping: false,
            timestamp: new Date().toISOString(),
          },
        });
      }

      // sender send success response
      callbackFn(callback, {
        success: true,
        message: 'Stop typing status sent successfully',
        data: {
          chatId,
          receiverNotified: !!otherUserId,
        },
      });
    } catch (err: any) {
      console.error('❌ Stop typing handler error:', err.message);
      callbackFn(callback, {
        success: false,
        message: err.message || 'Internal server error',
        data: null,
      });
    }
  }
);