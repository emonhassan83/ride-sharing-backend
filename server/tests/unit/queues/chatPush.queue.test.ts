/**
 * Issue 52: "I messaged the driver during the ride and got no notification".
 *
 * Root causes fixed in queues/chatPush.queue.ts:
 *  1. Opening a chat set a "user is viewing this chat" flag for 24 HOURS. Nothing cleared
 *     it when the app went back to the map (socket still connected), so every later
 *     message skipped the push. Now: 120 s, refreshed by activity in the chat.
 *  2. The flag outlived the socket that set it (reconnect / app killed). Now it stores
 *     the socket id and is ignored once that socket is gone.
 *  3. A message arriving while that chat's batch job was running was stranded: BullMQ
 *     ignores add() with an existing jobId. Now it gets its own job.
 *  4. The worker read and deleted the buffer in two steps; now it is one MULTI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bull = vi.hoisted(() => ({
  jobs: new Map<string, { state: string; remove: () => Promise<void> }>(),
  added: [] as Array<{ name: string; data: any; opts: any }>,
  processor: null as null | ((job: any) => Promise<any>),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn(function () {
    return {
      getJob: async (id: string) => {
        const job = bull.jobs.get(id);
        return job ? { getState: async () => job.state, remove: job.remove } : undefined;
      },
      add: async (name: string, data: any, opts: any) => {
        bull.added.push({ name, data, opts });
      },
    };
  }),
  Worker: vi.fn(function (_name: string, processor: any) {
    bull.processor = processor;
    return { on: vi.fn() };
  }),
}));
vi.mock('@src/app/config/queue.configs', () => ({ createQueueOptions: () => ({}) }));
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));
vi.mock('@src/app/utils/sentPushNotification', () => ({ sendNotification: vi.fn() }));
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/messages/messages.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Message: createModelMock() };
});
vi.mock('@src/app/modules/chat/chat.models', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Chat: createModelMock() };
});

import {
  CHAT_ACTIVE_TTL_SECONDS,
  enqueueChatPushNotification,
  getChatActiveKey,
  getChatBatchJobId,
  getChatBufferKey,
  initChatPushWorker,
  isUserActiveInChat,
  refreshUserActiveInChat,
  setUserActiveInChat,
} from '@src/app/queues/chatPush.queue';
import { getIO } from '@src/app/socket/socket.init';
import { sendNotification } from '@src/app/utils/sentPushNotification';
import { User } from '@src/app/modules/user/user.model';
import { Message } from '@src/app/modules/messages/messages.model';
import { Chat } from '@src/app/modules/chat/chat.models';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';

const chatId = oidStr();
const rider = oidStr();
const driver = oidStr();
let connectedSockets: Set<string>;

beforeEach(() => {
  bull.jobs.clear();
  bull.added.length = 0;
  connectedSockets = new Set(['driver-socket']);
  vi.mocked(getIO).mockImplementation(
    () => ({ sockets: { sockets: { has: (id: string) => connectedSockets.has(id) } } }) as any,
  );
  vi.mocked(User.findById).mockReturnValue(
    mockQuery({ _id: driver, fcmToken: 'driver-token', isDeleted: false, status: 'active' }) as any,
  );
  vi.mocked(Message.countDocuments).mockReturnValue(mockQuery(1) as any);
  vi.mocked(Chat.findById).mockReturnValue(mockQuery({ booking: 'b1' }) as any);
  vi.mocked(sendNotification).mockResolvedValue({ successCount: 1, failureCount: 0 } as any);
});

const send = (text: string) =>
  enqueueChatPushNotification({ chatId, senderId: rider, senderName: 'Rider', receiverId: driver, text });

describe('ISSUE 52: "viewing this chat" presence', () => {
  it('lasts 120 seconds, not 24 hours', async () => {
    await setUserActiveInChat(chatId, driver, 'driver-socket');

    expect(CHAT_ACTIVE_TTL_SECONDS).toBe(120);
    expect(await fakeRedis.ttl(getChatActiveKey(chatId, driver))).toBe(120);
  });

  it('driver opened the chat, went back to the map (no leave-chat), 2+ min later a message IS pushed', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-23T10:00:00Z'), toFake: ['Date'] });
    await setUserActiveInChat(chatId, driver, 'driver-socket');
    expect((await send('Where are you?')).bypassed).toBe(true); // still on the chat screen

    vi.setSystemTime(new Date('2026-11-23T10:02:01Z'));

    expect(await send('I am at the gate')).toEqual({ bypassed: false, queued: true });
  });

  it('a flag left by a socket that is gone (reconnect / app killed) no longer suppresses pushes', async () => {
    await setUserActiveInChat(chatId, driver, 'old-socket'); // old-socket is not connected

    expect(await isUserActiveInChat(chatId, driver)).toBe(false);
    expect((await send('Hello')).queued).toBe(true);
  });

  it('a flag from the still-connected socket does suppress the push (user is reading the chat)', async () => {
    await setUserActiveInChat(chatId, driver, 'driver-socket');

    expect(await send('Hello')).toEqual({ bypassed: true, queued: false });
  });

  it('activity in the chat extends presence; refreshing never marks an absent user present', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-23T10:00:00Z'), toFake: ['Date'] });
    await setUserActiveInChat(chatId, driver, 'driver-socket');
    vi.setSystemTime(new Date('2026-11-23T10:01:30Z'));
    await refreshUserActiveInChat(chatId, driver); // typing / seen / send-message
    vi.setSystemTime(new Date('2026-11-23T10:03:00Z')); // 3 min after join, 90 s after refresh

    expect(await isUserActiveInChat(chatId, driver)).toBe(true);

    await refreshUserActiveInChat(chatId, rider); // rider never joined
    expect(await isUserActiveInChat(chatId, rider)).toBe(false);
  });
});

describe('ISSUE 52: batching does not lose messages', () => {
  it('a message that arrives while the batch job is running gets its own job (was silently dropped)', async () => {
    bull.jobs.set(getChatBatchJobId(driver, chatId), { state: 'active', remove: vi.fn() });

    await send('second message');

    expect(bull.added).toHaveLength(1);
    expect(bull.added[0].opts.jobId).toMatch(new RegExp(`^${getChatBatchJobId(driver, chatId)}_\\d+$`));
  });

  it('a delayed job is replaced (debounce) and keeps the stable job id', async () => {
    const remove = vi.fn(async () => undefined);
    bull.jobs.set(getChatBatchJobId(driver, chatId), { state: 'delayed', remove });

    await send('again');

    expect(remove).toHaveBeenCalledTimes(1);
    expect(bull.added[0].opts.jobId).toBe(getChatBatchJobId(driver, chatId));
  });

  it('the worker sends the buffered messages as one push and empties the buffer atomically', async () => {
    await send('one');
    await send('two');
    initChatPushWorker();

    const result = await bull.processor!({
      data: { chatId, receiverId: driver, senderId: rider, senderName: 'Rider' },
    });

    expect(result).toMatchObject({ sent: true, batchCount: 2 });
    expect(sendNotification).toHaveBeenCalledWith(
      ['driver-token'],
      expect.objectContaining({ description: 'one\ntwo', receiver: driver }),
    );
    expect(await fakeRedis.llen(getChatBufferKey(chatId, driver))).toBe(0);
  });

  it('the worker still skips the push if the receiver opened the chat during the debounce window', async () => {
    await send('one');
    await setUserActiveInChat(chatId, driver, 'driver-socket');
    initChatPushWorker();

    const result = await bull.processor!({
      data: { chatId, receiverId: driver, senderId: rider, senderName: 'Rider' },
    });

    expect(result).toEqual({ skipped: true, reason: 'receiver_active_in_chat' });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
