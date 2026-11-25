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
import { getIO } from '../socket/socket.init';

const CHAT_PUSH_QUEUE_NAME = 'chat-push-queue';
const CHAT_PUSH_DEBOUNCE_DELAY_MS = 2500; // 2.5 seconds debounce window
const CHAT_BUFFER_TTL_SECONDS = 3600; // 1 hour buffer safety expiry
/**
 * "User is looking at this chat" lasts this long unless refreshed by activity
 * in the chat (join-chat, send-message, typing, seen). Issue 52: it used to be
 * 24 hours, so a driver who opened the chat once and then went back to the map
 * (socket still connected, no leave-chat) never got another chat push.
 */
export const CHAT_ACTIVE_TTL_SECONDS = 120;
/** Legacy presence value from before presence was bound to a socket id. */
const LEGACY_PRESENCE_VALUE = '1';

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

/** True when the socket that marked the presence is still connected to this server. */
const isPresenceSocketConnected = (socketId: string): boolean => {
  try {
    return getIO().sockets.sockets.has(socketId);
  } catch {
    return true; // Socket.io not initialised (e.g. worker context): trust the key
  }
};

export const isUserActiveInChat = async (
  chatId: string,
  userId: string,
): Promise<boolean> => {
  try {
    const redis = getRedisClient();
    const value = await redis.get(getChatActiveKey(chatId, userId));
    if (!value) return false;
    if (value === LEGACY_PRESENCE_VALUE) return true;
    // Presence left by a socket that has since died (network blip, app killed,
    // reconnect with a new socket) no longer suppresses pushes.
    return isPresenceSocketConnected(value);
  } catch {
    return false;
  }
};

export const setUserActiveInChat = async (
  chatId: string,
  userId: string,
  socketId?: string,
): Promise<void> => {
  const redis = getRedisClient();
  const activeKey = getChatActiveKey(chatId, userId);
  const userSetKey = getUserActiveChatsKey(userId);

  await Promise.all([
    redis.setex(activeKey, CHAT_ACTIVE_TTL_SECONDS, socketId || LEGACY_PRESENCE_VALUE),
    redis.sadd(userSetKey, chatId),
    redis.expire(userSetKey, CHAT_ACTIVE_TTL_SECONDS),
  ]);

  // Clear any buffered messages or pending push job for this chat
  await clearPendingChatPushBatch(chatId, userId);
};

/**
 * Extend presence while the user is visibly active in the chat. Does nothing
 * when the user is not marked present (EXPIRE on a missing key is a no-op), so
 * it can never mark someone present who left the chat.
 */
export const refreshUserActiveInChat = async (
  chatId: string,
  userId: string,
): Promise<void> => {
  try {
    const redis = getRedisClient();
    const extended = await redis.expire(
      getChatActiveKey(chatId, userId),
      CHAT_ACTIVE_TTL_SECONDS,
    );
    if (extended === 1) {
      await redis.expire(getUserActiveChatsKey(userId), CHAT_ACTIVE_TTL_SECONDS);
    }
  } catch {
    /* ignore */
  }
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
  const baseJobId = getChatBatchJobId(receiverId, chatId);
  let jobId = baseJobId;

  try {
    const existingJob = await queue.getJob(baseJobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === 'delayed' || state === 'waiting' || state === 'waiting-children') {
        await existingJob.remove();
      } else if (state === 'active') {
        // The batch for this chat is being sent right now and has already
        // taken the buffer. BullMQ silently ignores add() with an existing
        // jobId, which left this message in the buffer with no job (issue 52).
        jobId = `${baseJobId}_${Date.now()}`;
      }
    }
  } catch {
    /* ignore lookup errors; add() below still schedules a job */
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

      // 2. Take the last 4 buffered messages and clear the buffer in ONE atomic
      //    step. Separate LRANGE + DEL lost any message pushed in between.
      const [[, ranged]] = (await redis
        .multi()
        .lrange(bufferKey, -4, -1)
        .del(bufferKey)
        .exec()) as [[Error | null, string[]], [Error | null, number]];
      const rawMessages: string[] = Array.isArray(ranged) ? ranged : [];

      if (!rawMessages.length) {
        return { skipped: true, reason: 'empty_buffer' };
      }

      // 3. Validate receiver & FCM token
      const receiver = await User.findById(receiverId)
        .select('fcmToken isDeleted status role')
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
          ? `${displaySenderName} (${effectiveUnread} unread messages)`
          : displaySenderName;

      const description = formattedLines.join('\n');
      const bookingIdStr = chatDoc?.booking ? chatDoc.booking.toString() : '';

      await sendNotification([receiver.fcmToken], {
        receiver: receiverId,
        message: title,
        description,
        reference: bookingIdStr || chatId,
        modelType: modeType.Booking,
        recipientRole: receiver.role,
        data: {
          type: 'CHAT_MESSAGE',
          screen: 'chat',
          chatId: String(chatId),
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

