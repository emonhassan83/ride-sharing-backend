import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';
import { callbackFn } from '../../../utils/callbackFn';
import { Chat } from '../../../modules/chat/chat.models';
import {
  removeUserActiveFromChat,
  setUserActiveInChat,
} from '../../../queues/chatPush.queue';

export const joinChatHandler = eventHandler(
  async (socket: TSocket, payload: any, callback: any) => {
    const userId = socket.auth?._id?.toString();
    const chatId = payload?.chatId?.toString?.() || payload?.chat?.toString?.();

    if (!userId || !chatId) {
      return callbackFn(callback, {
        success: false,
        message: 'chatId is required',
      });
    }

    try {
      const chat = await Chat.findById(chatId).select('participants').lean();
      if (!chat) {
        return callbackFn(callback, {
          success: false,
          message: 'Chat not found',
        });
      }

      const isParticipant = chat.participants.some(
        (p: any) => p.toString() === userId,
      );
      if (!isParticipant) {
        return callbackFn(callback, {
          success: false,
          message: 'You are not a participant of this chat',
        });
      }

      // Join Socket.IO chat room and mark active in Redis (chat:active:<chatId>:<userId>)
      socket.join(`chat:${chatId}`);
      await setUserActiveInChat(chatId, userId);

      return callbackFn(callback, {
        success: true,
        message: 'Joined chat successfully',
        chatId,
      });
    } catch (err: any) {
      return callbackFn(callback, {
        success: false,
        message: err?.message || 'Failed to join chat',
      });
    }
  },
);

export const leaveChatHandler = eventHandler(
  async (socket: TSocket, payload: any, callback: any) => {
    const userId = socket.auth?._id?.toString();
    const chatId = payload?.chatId?.toString?.() || payload?.chat?.toString?.();

    if (!userId || !chatId) {
      return callbackFn(callback, {
        success: false,
        message: 'chatId is required',
      });
    }

    try {
      socket.leave(`chat:${chatId}`);
      await removeUserActiveFromChat(chatId, userId);

      return callbackFn(callback, {
        success: true,
        message: 'Left chat successfully',
        chatId,
      });
    } catch (err: any) {
      return callbackFn(callback, {
        success: false,
        message: err?.message || 'Failed to leave chat',
      });
    }
  },
);

