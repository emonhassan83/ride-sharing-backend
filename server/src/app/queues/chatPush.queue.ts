import { Job, Queue, Worker } from 'bullmq';
import { Types } from 'mongoose';
import { createQueueOptions } from '../config/queue.configs';
import { getRedisClient } from '../config/redis.config';
import { User } from '../modules/user/user.model';
import { USER_STATUS } from '../modules/user/user.constant';
import { Chat } from '../modules/chat/chat.models';
import { Message } from '../modules/messages/messages.model';
import { sendNotification } from '../utils/sentPushNotification';
import { modeType } from '../modules/notification/notification.interface';

const CHAT_PUSH_QUEUE_NAME = 'chat-push-queue';
const CHAT_PUSH_DEBOUNCE_DELAY_MS = 2500; // 2.5 seconds debounce window
const CHAT_BUFFER_TTL_SECONDS = 3600; // 1 hour buffer safety expiry
const CHAT_ACTIVE_TTL_SECONDS = 86400; // 24 hours presence safety expiry

let _chatPushQueue: Queue | null = null;
let _chatPushWorker: Worker | null = null;

export const getChatActiveKey = (chatId: string, userId: string) =>
  `chat:active:${chatId}:${userId}`;

export const getUserActiveChatsKey = (userId: string) =>
  `user:active_chats:${userId}`;

export const getChatBufferKey = (chatId: string, userId: string) =>
  `chat:buffer:${chatId}:${userId}`;

export const getChatBatchJobId = (userId: string, chatId: string) =>
  `batch_${userId}_${chatId}`;

export const getChatPushQueue = (): Queue => {
  if (!_chatPushQueue) {
    _chatPushQueue = new Queue(CHAT_PUSH_QUEUE_NAME, createQueueOptions());
  }
  return _chatPushQueue;
};

export const isUserActiveInChat = async (
  chatId: string,
  userId: string,
): Promise<boolean> => {
  try {
    const redis = getRedisClient();
    const exists = await redis.exists(getChatActiveKey(chatId, userId));
    return exists === 1;
  } catch {
    return false;
  }
};

export const setUserActiveInChat = async (
  chatId: string,
  userId: string,
): Promise<void> => {
  const redis = getRedisClient();
  const activeKey = getChatActiveKey(chatId, userId);
  const userSetKey = getUserActiveChatsKey(userId);

  await Promise.all([
    redis.setex(activeKey, CHAT_ACTIVE_TTL_SECONDS, '1'),
    redis.sadd(userSetKey, chatId),
    redis.expire(userSetKey, CHAT_ACTIVE_TTL_SECONDS),
  ]);

  // Clear any buffered messages or pending push job for this chat
  await clearPendingChatPushBatch(chatId, userId);
};

export const removeUserActiveFromChat = async (
  chatId: string,
  userId: string,
): Promise<void> => {
  const redis = getRedisClient();
  await Promise.all([
    redis.del(getChatActiveKey(chatId, userId)),
    redis.srem(getUserActiveChatsKey(userId), chatId),
  ]);
};

export const clearAllActiveChatsForUser = async (
  userId: string,
): Promise<void> => {
  try {
    const redis = getRedisClient();
    const userSetKey = getUserActiveChatsKey(userId);
    const activeChatIds = await redis.smembers(userSetKey);

    if (activeChatIds.length > 0) {
      const keysToDelete = activeChatIds.map((chatId) =>
        getChatActiveKey(chatId, userId),
      );
      await redis.del(...keysToDelete);
    }
    await redis.del(userSetKey);
  } catch {
    /* ignore redis cleanup error */
  }
};

export const clearPendingChatPushBatch = async (
  chatId: string,
  userId: string,
): Promise<void> => {
  try {
    const redis = getRedisClient();
    await redis.del(getChatBufferKey(chatId, userId));

    const queue = getChatPushQueue();
    const jobId = getChatBatchJobId(userId, chatId);
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'delayed' || state === 'waiting' || state === 'waiting-children') {
        await existingJob.remove();
      }
    }
  } catch {
    /* ignore cleanup errors */
  }
};

export type TBufferedChatMessage = {
  messageId?: string;
  senderId: string;
  senderName: string;
  text?: string;
  hasImage?: boolean;
  createdAt: number;
};

export const enqueueChatPushNotification = async (params: {
  chatId: string;
  senderId: string;
  senderName?: string;
  receiverId: string;
  text?: string;
  imageUrl?: string[];
  messageId?: string;
}): Promise<{ bypassed: boolean; queued: boolean }> => {
  const {
    chatId,
    senderId,
    senderName,
    receiverId,
    text,
    imageUrl,
    messageId,
  } = params;

  if (!chatId || !receiverId || senderId === receiverId) {
    return { bypassed: true, queued: false };
  }

  // 1. Push Bypass Check: if receiver is currently active inside this chat screen, skip FCM push
  const activeInChat = await isUserActiveInChat(chatId, receiverId);
  if (activeInChat) {
    return { bypassed: true, queued: false };
  }

  // Resolve sender name if not provided
  let resolvedSenderName = senderName?.trim() || '';
  if (!resolvedSenderName) {
    const sender = await User.findById(senderId).select('name').lean();
    resolvedSenderName = sender?.name || 'New Message';
  }

  // 2. Push message into Redis buffer list: chat:buffer:<chatId>:<userId>
  const redis = getRedisClient();
  const bufferKey = getChatBufferKey(chatId, receiverId);
  const bufferedItem: TBufferedChatMessage = {
    messageId,
    senderId,
    senderName: resolvedSenderName,
    text: text?.trim() || '',
    hasImage: Array.isArray(imageUrl) && imageUrl.length > 0,
    createdAt: Date.now(),
  };

  await redis.rpush(bufferKey, JSON.stringify(bufferedItem));
  await redis.expire(bufferKey, CHAT_BUFFER_TTL_SECONDS);

  // 3. Debounce Job in BullMQ: jobId = batch_<userId>_<chatId> with 2.5s delay
  const queue = getChatPushQueue();
  const jobId = getChatBatchJobId(receiverId, chatId);

  try {
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'delayed' || state === 'waiting' || state === 'waiting-children') {
        await existingJob.remove();
      }
    }
  } catch {
    /* ignore if job already active/completed */
  }

  await queue.add(
    'dispatch-chat-batch-push',
    {
      chatId,
      receiverId,
      senderId,
      senderName: resolvedSenderName,
    },
    {
      jobId,
      delay: CHAT_PUSH_DEBOUNCE_DELAY_MS,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );

  return { bypassed: false, queued: true };
};

export const initChatPushWorker = (): Worker => {
  if (_chatPushWorker) {
    return _chatPushWorker;
  }

  _chatPushWorker = new Worker(
    CHAT_PUSH_QUEUE_NAME,
    async (job: Job) => {
      const { chatId, receiverId, senderId, senderName } = job.data as {
        chatId: string;
        receiverId: string;
        senderId: string;
        senderName: string;
      };

      const redis = getRedisClient();
      const bufferKey = getChatBufferKey(chatId, receiverId);

      // 1. Re-check if receiver entered the chat during the debounce window
      const activeNow = await isUserActiveInChat(chatId, receiverId);
      if (activeNow) {
        await redis.del(bufferKey);
        return { skipped: true, reason: 'receiver_active_in_chat' };
      }

      // 2. Fetch last 4 buffered messages and delete buffer key immediately
      const rawMessages = await redis.lrange(bufferKey, -4, -1);
      await redis.del(bufferKey);

      if (!rawMessages.length) {
        return { skipped: true, reason: 'empty_buffer' };
      }

      // 3. Validate receiver & FCM token
      const receiver = await User.findById(receiverId)
        .select('fcmToken isDeleted status')
        .lean();

      if (
        !receiver ||
        receiver.isDeleted ||
        receiver.status === USER_STATUS.blocked ||
        !receiver.fcmToken
      ) {
        return { skipped: true, reason: 'receiver_unavailable_or_no_fcm' };
      }

      const parsedMessages: TBufferedChatMessage[] = rawMessages
        .map((raw) => {
          try {
            return JSON.parse(raw) as TBufferedChatMessage;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as TBufferedChatMessage[];

      if (!parsedMessages.length) {
        return { skipped: true, reason: 'no_valid_buffered_messages' };
      }

      // 4. Query unread count for this chat and booking reference
      const [chatUnreadCount, totalUnreadCount, chatDoc] = await Promise.all([
        Message.countDocuments({
          chat: new Types.ObjectId(chatId),
          seen: false,
          sender: { $ne: new Types.ObjectId(receiverId) },
        }),
        Message.countDocuments({
          receiver: new Types.ObjectId(receiverId),
          seen: false,
        }),
        Chat.findById(chatId).select('booking').lean(),
      ]);

      const displaySenderName =
        parsedMessages[parsedMessages.length - 1]?.senderName ||
        senderName ||
        'Ride Chat';

      const formattedLines = parsedMessages.map((msg) => {
        if (msg.text && msg.hasImage) return `📷 ${msg.text}`;
        if (msg.text) return msg.text;
        if (msg.hasImage) return '📷 Sent a photo';
        return 'New message';
      });

      const effectiveUnread = Math.max(chatUnreadCount, parsedMessages.length);
      const title =
        effectiveUnread > 1
          ? `💬 ${displaySenderName} (${effectiveUnread} unread messages)`
          : `💬 ${displaySenderName}`;

      const description = formattedLines.join('\n');
      const bookingIdStr = chatDoc?.booking ? chatDoc.booking.toString() : '';

      await sendNotification([receiver.fcmToken], {
        receiver: receiverId,
        message: title,
        description,
        reference: bookingIdStr || chatId,
        modelType: modeType.Booking,
        data: {
          type: 'CHAT_MESSAGE',
          chatId,
          senderId,
          senderName: displaySenderName,
          bookingId: bookingIdStr,
          unreadCount: String(effectiveUnread),
          totalUnreadCount: String(totalUnreadCount),
        },
      });

      return {
        sent: true,
        chatId,
        receiverId,
        batchCount: parsedMessages.length,
        unreadCount: effectiveUnread,
      };
    },
    {
      connection: getRedisClient() as any,
      concurrency: 10,
    },
  );

  _chatPushWorker.on('failed', (job, err) => {
    console.error(`❌ ChatPushWorker job failed (${job?.id}):`, err?.message || err);
  });

  return _chatPushWorker;
};

