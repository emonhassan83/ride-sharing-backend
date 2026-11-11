// src/app/socket/handlers/chat/sendMessage.handler.ts
import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';
import { Chat } from '../../../modules/chat/chat.models';
import { chatService } from '../../../modules/chat/chat.service';
import httpStatus from 'http-status';
import { callbackFn } from '../../../utils/callbackFn';
import { Message } from '../../../modules/messages/messages.model';
import { getIO } from '../../socket.init';
import {
  enqueueChatPushNotification,
  isUserActiveInChat,
} from '../../../queues/chatPush.queue';

export const sendMessageHandler = eventHandler(
  async (socket: TSocket, payload: any, callback: any) => {
    const userId = socket.auth._id.toString();
    const { chatId, text, imageUrl = [] } = payload;

    console.log('📨 send-message received from:', userId, 'chatId:', chatId);

    try {
      // 1. validate chatId
      if (!chatId) {
        return callbackFn(callback, {
          success: false,
          message: 'chatId is required',
        });
      }

      // 2. find text or image url
      if (!text?.trim() && (!imageUrl || imageUrl.length === 0)) {
        return callbackFn(callback, {
          success: false,
          message: 'text or imageUrl is required',
        });
      }

      // 3. find chat and validate
      const chat = await Chat.findById(chatId).populate('participants', '_id name');
      if (!chat) {
        return callbackFn(callback, {
          success: false,
          message: 'Chat not found',
        });
      }

      // 4. Check precipitant
      const senderParticipant = chat.participants.find(
        (p: any) => p._id.toString() === userId
      ) as any;
      if (!senderParticipant) {
        return callbackFn(callback, {
          success: false,
          message: 'You are not a participant of this chat',
        });
      }

      // 5. sent receiver join the room
      const otherParticipant = chat.participants.find(
        (p: any) => p._id.toString() !== userId
      ) as any;
      if (!otherParticipant) {
        return callbackFn(callback, {
          success: false,
          message: 'No other participant found in chat',
        });
      }
      const finalReceiverId = otherParticipant._id.toString();

      // Check if receiver is currently active inside this specific chat screen
      const receiverActiveInChat = await isUserActiveInChat(
        chat._id.toString(),
        finalReceiverId
      );

      // 6. Creation message
      const message = await Message.create({
        chat: chat._id,
        sender: userId,
        receiver: finalReceiverId,
        text: text?.trim(),
        imageUrl,
        seen: receiverActiveInChat,
      });

      const populated = await Message.findById(message._id).select(
        'text imageUrl seen isEdited sender createdAt'
      );

      const io = getIO();
      // emit to users (both user room and chat room)
      socket.emit('new-message', populated);
      io.to(finalReceiverId).emit('new-message', populated);
      io.to(`chat:${chat._id.toString()}`).emit(
        `new-message::${chat._id.toString()}`,
        populated
      );

      // chat list update
      const [senderChatList, receiverChatList] = await Promise.all([
        chatService.getMyChatList(userId, {}),
        chatService.getMyChatList(finalReceiverId, {}),
      ]);
      socket.emit('chat-list', senderChatList);
      io.to(finalReceiverId).emit('chat-list', receiverChatList);

      // unread notification
      const unreadCount = await Message.countDocuments({
        receiver: finalReceiverId,
        seen: false,
      });
      io.to(finalReceiverId).emit('new-notifications', unreadCount);

      // 7. Push Bypass Check + Redis Buffer + BullMQ Debounced Batch Push
      if (!receiverActiveInChat) {
        await enqueueChatPushNotification({
          chatId: chat._id.toString(),
          senderId: userId,
          senderName: senderParticipant?.name || socket.auth?.name || '',
          receiverId: finalReceiverId,
          text: text?.trim(),
          imageUrl,
          messageId: message._id.toString(),
        });
      }

      callbackFn(callback, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Message sent successfully!',
        populated,
      });
    } catch (err: any) {
      console.error('❌ send-message error:', err.message);
      callbackFn(callback, { success: false, message: err.message });
    }
  }
);
