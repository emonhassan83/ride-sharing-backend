// src/app/socket/handlers/chat/seen.handler.ts
import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';
import { Chat } from '../../../modules/chat/chat.models';
import { chatService } from '../../../modules/chat/chat.service';
import { Types } from 'mongoose';
import { callbackFn } from '../../../utils/callbackFn';
import { Message } from '../../../modules/messages/messages.model';

export const seenHandler = eventHandler(async (socket: TSocket, { chatId }: any, callback: any) => {
  const userId = socket.auth._id.toString();

  if (!chatId) {
    return callbackFn(callback, { success: false, message: 'chatId is required' });
  }

  try {
    const chat = await Chat.findById(chatId);
    if (!chat) {
      return callbackFn(callback, { success: false, message: 'Chat not found' });
    }

    // 1. Current user exits all messages seen
    await Message.updateMany(
      {
        chat: chatId,
        seen: false,
        sender: { $ne: new Types.ObjectId(userId) },
      },
      { $set: { seen: true } }
    );

    // 2. Only chatId updated version
    const updatedSingleChat = await chatService.getSingleChat(chatId, userId); 
    if (!updatedSingleChat) {
      return callbackFn(callback, { success: false, message: 'Failed to fetch updated chat' });
    }

    // 3. find chat precipitant
    const participantIds = chat.participants.map((p) => p.toString());

    await Promise.all(
      participantIds.map(async (participantId) => {
        // update to chat user
        socket.to(participantId).emit('chat-list', updatedSingleChat);

        // Unread count update
        const unreadCount = await Message.countDocuments({
          receiver: participantId,
          seen: false,
        });
        socket.to(participantId).emit('new-notifications', unreadCount);
      })
    );

    // send caller success message
    callbackFn(callback, { success: true });
  } catch (err: any) {
    console.error('seen handler error:', err.message);
    callbackFn(callback, { success: false, message: err.message });
  }
});