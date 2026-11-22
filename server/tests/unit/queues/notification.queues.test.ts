/**
 * Unit tests: notification queue producer (`getNotificationQueue`, `addNotificationJob`).
 *
 * CONTRACT with the worker package: queue 'notification-queue' is consumed by
 * worker/src/app/workers/notification.workers.ts, which reads
 * `{ userId, title, message, fcmToken, data }` from `job.data` and ignores the job NAME.
 *
 * NOTE (dead code): nothing in server/src calls `addNotificationJob` / `getNotificationQueue`
 * apart from `notificationQueueHelper.ts` (itself unused): ride notifications are sent directly
 * through `notifyUser.utils` -> `sentPushNotification`. The tests below still pin the contract,
 * because the worker is deployed and would start receiving jobs the day a caller appears.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { freezeTime } from '@tests/helpers/time';

const bull = vi.hoisted(() => ({ queues: [] as any[] }));

vi.mock('bullmq', () => ({
  Queue: vi.fn(function (this: any, name: string, opts: any) {
    const queue = {
      name,
      opts,
      add: vi.fn(async () => ({ id: 'job-1' })),
      close: vi.fn(),
      on: vi.fn(),
    };
    bull.queues.push(queue);
    return queue;
  }),
  Worker: vi.fn(),
}));

const load = async () => {
  vi.resetModules();
  return import('@src/app/queues/notification.queues');
};

const baseData = {
  userId: '64b000000000000000000001',
  fcmToken: 'tok-1',
  title: 'Ride accepted',
  message: 'Your driver is on the way',
};

beforeEach(() => {
  bull.queues.length = 0;
});

describe('getNotificationQueue', () => {
  it("creates a Queue named exactly 'notification-queue' on the shared Redis connection", async () => {
    const { getNotificationQueue } = await load();

    const queue = await getNotificationQueue();

    expect(bull.queues).toHaveLength(1);
    expect(bull.queues[0].name).toBe('notification-queue');
    expect(queue).toBe(bull.queues[0]);
    expect(bull.queues[0].opts.connection).toBe(fakeRedis);
  });

  it('is a singleton across calls', async () => {
    const { getNotificationQueue } = await load();
    const a = await getNotificationQueue();
    const b = await getNotificationQueue();
    expect(b).toBe(a);
    expect(bull.queues).toHaveLength(1);
  });

  it('uses 3 attempts with 2s exponential back-off and bounded history (100 completed / 500 failed)', async () => {
    const { getNotificationQueue } = await load();
    await getNotificationQueue();

    expect(bull.queues[0].opts.defaultJobOptions).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  });
});

describe('addNotificationJob', () => {
  beforeEach(() => {
    freezeTime('2026-03-20T10:00:00.000Z');
  });

  it("enqueues job name 'send-notification' and returns the BullMQ job id", async () => {
    const { addNotificationJob } = await load();

    const id = await addNotificationJob(baseData);

    expect(id).toBe('job-1');
    const [name] = bull.queues[0].add.mock.calls[0];
    expect(name).toBe('send-notification');
  });

  it('sends every field the worker destructures (userId, title, message, fcmToken, data) unchanged', async () => {
    const { addNotificationJob } = await load();

    await addNotificationJob({ ...baseData, data: { type: 'RIDE', rideId: 'r1' } });

    const payload = bull.queues[0].add.mock.calls[0][1];
    expect(payload).toMatchObject({
      userId: baseData.userId,
      fcmToken: 'tok-1',
      title: 'Ride accepted',
      message: 'Your driver is on the way',
      data: { type: 'RIDE', rideId: 'r1' },
    });
  });

  it("stamps metadata with the supplied traceId and the current time, keeping caller metadata", async () => {
    const { addNotificationJob } = await load();

    await addNotificationJob(
      { ...baseData, metadata: { source: 'ride-service', traceId: 'ignored-by-arg' } },
      'trace-123',
    );

    const payload = bull.queues[0].add.mock.calls[0][1];
    expect(payload.metadata).toEqual({
      source: 'ride-service',
      traceId: 'trace-123',
      timestamp: new Date('2026-03-20T10:00:00.000Z'),
    });
  });

  it("falls back to traceId 'NO_TRACE_ID' when none is provided", async () => {
    const { addNotificationJob } = await load();
    await addNotificationJob(baseData);
    expect(bull.queues[0].add.mock.calls[0][1].metadata.traceId).toBe('NO_TRACE_ID');
  });

  it('does not mutate the caller input object', async () => {
    const { addNotificationJob } = await load();
    const input = { ...baseData, metadata: { source: 's' } };
    const snapshot = JSON.parse(JSON.stringify(input));

    await addNotificationJob(input, 't');

    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it.each([
    [undefined, 3],
    [1, 1],
    [5, 5],
  ])('priority %s -> job priority %s (default 3)', async (priority, expected) => {
    const { addNotificationJob } = await load();
    await addNotificationJob({ ...baseData, priority: priority as any });
    expect(bull.queues[0].add.mock.calls[0][2].priority).toBe(expected);
  });

  it('builds jobId as notif_<userId>_<epoch ms>', async () => {
    const { addNotificationJob } = await load();
    await addNotificationJob(baseData);
    expect(bull.queues[0].add.mock.calls[0][2].jobId).toBe(
      `notif_${baseData.userId}_${new Date('2026-03-20T10:00:00.000Z').getTime()}`,
    );
  });

  it('propagates a queue failure to the caller', async () => {
    const { addNotificationJob, getNotificationQueue } = await load();
    const queue = (await getNotificationQueue()) as any;
    queue.add.mockRejectedValueOnce(new Error('redis down'));

    await expect(addNotificationJob(baseData)).rejects.toThrow('redis down');
  });

  describe('KNOWN BUGS', () => {
    // BUG-REPORT UTIL-1 | low | server/src/app/queues/notification.queues.ts:57
    // jobId = `notif_${userId}_${Date.now()}`: two notifications for the same user created within
    // the same millisecond get the SAME BullMQ jobId, and BullMQ silently ignores the second add
    // (duplicate id) => one notification is lost without any error. Dead code today (no caller),
    // but any burst (e.g. Promise.all of two pushes) would trigger it. Fix: append a counter/uuid.
    it.fails('BUG UTIL-1: two jobs for the same user in the same millisecond get distinct jobIds', async () => {
      const { addNotificationJob } = await load();

      await Promise.all([
        addNotificationJob({ ...baseData, message: 'first' }),
        addNotificationJob({ ...baseData, message: 'second' }),
      ]);

      const [first, second] = bull.queues[0].add.mock.calls.map((c: any[]) => c[2].jobId);
      expect(first).not.toBe(second);
    });
  });
});
