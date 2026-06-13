import httpStatus from 'http-status';
import { deleteFromS3 } from '../../utils/s3';
import { TChat } from './chat.interface';
import { Chat } from './chat.models';
import { User } from '../user/user.model';
import { Types } from 'mongoose';
import ApiError from '../../errors/ApiError';
import { Message } from '../messages/messages.model';
import { Booking } from '../booking/booking.model';
import { CHAT_STATUS } from './chat.constants';

const createChat = async (payload: TChat) => {
  const { participants, booking: bookingId } = payload;

  if (!participants || participants.length !== 2) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Exactly two participants are required to create a chat'
    );
  }
  if (!bookingId) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Booking is required to create a chat'
    );
  }

  const booking = await Booking.findById(bookingId);
  if (!booking) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Booking not found');
  }

  const bookingExists = await Chat.findOne({ booking: bookingId });
  if (bookingExists) {
    return bookingExists;
  }

  const [user1, user2] = await Promise.all([
    User.findById(payload?.participants[0]),
    User.findById(payload?.participants[1]),
  ]);
  if (!user1 || !user2) {
    throw new ApiError(httpStatus.NOT_FOUND, 'One or both users not found');
  }

  // Chat creation
  try {
    const result = await Chat.create({
      booking: bookingId,
      participants,
      status: CHAT_STATUS.accepted,
    });
    return result;
  } catch (error: any) {
    // if face duplicate error then return previous one
    if (error.code === 11000) {
      const existing = await Chat.findOne({ booking: bookingId });
      if (existing) return existing;
    }
    throw new ApiError(httpStatus.BAD_REQUEST, 'Chat creation failed');
  }
};

const getMyChatList = async (
  userId: string,
  query: Record<string, unknown>
) => {
  const searchTerm = query.searchTerm as string | undefined;

  const chats = await Chat.find({
    participants: userId,
  })
    .populate({
      path: 'participants',
      select: 'name profileImage',
      match: { _id: { $ne: userId } },
    })
    .select('_id participants status');

  if (!chats) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Chat list not found');
  }

  // ✅ Promise.all দিয়ে parallel query করো
  const dataWithMessages = await Promise.all(
    chats.map(async (chatItem) => {
      const participant = chatItem?.participants?.[0] as any;

      // ✅ 'name' in participant check বাদ
      if (!participant || typeof participant !== 'object') return null;

      // Search filter
      if (searchTerm) {
        const fullName =
          `${participant?.firstName || ''} ${participant?.lastName || ''}`.toLowerCase();
        if (!fullName.includes(searchTerm.toLowerCase())) return null;
      }

      const chatId = chatItem?._id;

      const [message, unreadMessageCount] = await Promise.all([
        Message.findOne({ chat: chatId })
          .sort({ createdAt: -1 })
          .select('text imageUrl seen sender createdAt')
          .populate([{ path: 'sender', select: 'name profileImage' }]),
        Message.countDocuments({
          chat: chatId,
          seen: false,
          sender: { $ne: userId },
        }),
      ]);

      return {
        chat: chatItem,
        lastMessage: message || null,
        unreadMessageCount,
      };
    })
  );

  // null filter করো
  const data = dataWithMessages.filter(Boolean) as any[];

  // Latest message এর based এ sort করো
  data.sort((a, b) => {
    const dateA = a.message?.createdAt
      ? new Date(a.message.createdAt).getTime()
      : 0;
    const dateB = b.message?.createdAt
      ? new Date(b.message.createdAt).getTime()
      : 0;
    return dateB - dateA;
  });

  return data;
};

const getSingleChat = async (chatId: string, userId: string) => {
  try {
    // 1. Find the specific chat
    const chatItem = await Chat.findById(chatId)
      .populate({
        path: 'participants',
        select: 'name profileImage',
        match: { _id: { $ne: userId } },
      })
      .select('_id participants status')
      .lean();

    if (!chatItem) {
      return null;
    }

    const participant = chatItem?.participants?.[0] as any;

    if (!participant || typeof participant !== 'object') {
      return null;
    }

    const [lastMessage, unreadMessageCount] = await Promise.all([
      Message.findOne({ chat: chatId })
        .sort({ createdAt: -1 })
        .select('text imageUrl seen sender createdAt')
        .populate([{ path: 'sender', select: 'name profileImage' }])
        .lean(),

      Message.countDocuments({
        chat: chatId,
        seen: false,
        sender: { $ne: new Types.ObjectId(userId) },
      }),
    ]);

    return {
      chat: chatItem,
      lastMessage: lastMessage || null,
      unreadMessageCount,
    };
  } catch (error: any) {
    console.error('getSingleChat error:', error.message);
    return null;
  }
};

const getChatBookingById = async (bookingId: string, userId: string) => {
  const result = await Chat.findOne({ booking: bookingId }).populate({
    path: 'participants',
    select: 'name profileImage',
    match: { _id: { $ne: userId } },
  });
  if (!result) throw new ApiError(httpStatus.BAD_REQUEST, 'Chat not found');

  // const isParticipant = result.participants.some(
  //   (participant: any) => participant._id.toString() === userId
  // );
  // if (!isParticipant) {
  //   throw new ApiError(
  //     httpStatus.FORBIDDEN,
  //     'You are not a participant of this chat'
  //   );
  // }

  return result;
};

const getChatByUserId = async (currentUser: string, userId: string) => {
  const chats = await Chat.find({
    participants: { $all: [currentUser, userId] },
  }).populate({
    path: 'participants',
    select: 'name profileImage',
    match: { _id: { $ne: currentUser } },
  });

  if (!chats) throw new ApiError(httpStatus.BAD_REQUEST, 'Chat list not found');

  const dataWithMessages = await Promise.all(
    chats.map(async (chatItem) => {
      const participant = chatItem?.participants?.[0] as any;

      // ✅ fix — 'name' in participant check বাদ
      if (!participant || typeof participant !== 'object') return null;

      const chatId = chatItem?._id;

      const [message, unreadMessageCount] = await Promise.all([
        Message.findOne({ chat: chatId }).sort({ createdAt: -1 }),
        Message.countDocuments({
          chat: chatId,
          seen: false,
          sender: { $ne: currentUser },
        }),
      ]);

      return { chat: chatItem, message: message || null, unreadMessageCount };
    })
  );

  const data = dataWithMessages.filter(Boolean) as any[];

  data.sort((a, b) => {
    const dateA = a.message?.createdAt
      ? new Date(a.message.createdAt).getTime()
      : 0;
    const dateB = b.message?.createdAt
      ? new Date(b.message.createdAt).getTime()
      : 0;
    return dateB - dateA;
  });

  return data;
};

const updateChatList = async (id: string, payload: Partial<TChat>) => {
  const result = await Chat.findByIdAndUpdate(id, payload, { returnDocument: 'after' });
  if (!result) throw new ApiError(httpStatus.BAD_REQUEST, 'Chat not found');
  return result;
};

const deleteChatList = async (id: string) => {
  await deleteFromS3(`images/messages/${id}`);
  const result = await Chat.findByIdAndDelete(id);
  if (!result) throw new ApiError(httpStatus.BAD_REQUEST, 'Chat not found');
  return result;
};

const checkUserExists = async (userId: string) => {
  const user = await User.findById(userId).select('_id');
  return !!user;
};

export const chatService = {
  createChat,
  getMyChatList,
  getSingleChat,
  getChatBookingById,
  getChatByUserId,
  updateChatList,
  deleteChatList,
  checkUserExists,
};
