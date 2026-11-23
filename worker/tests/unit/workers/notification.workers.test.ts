/**
 * Unit tests: BullMQ notification consumer (`notification-queue`).
 *
 * Flow: job -> FCM push -> (on success) persist an in-app Notification by POSTing to the server API.
 * The producer is server/src/app/queues/notification.queues.ts (`addNotificationJob`), whose job
 * data is `{ userId, fcmToken, title, message, data?, priority?, metadata: { traceId, ... } }`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { WorkerMock } = vi.hoisted(() => ({ WorkerMock: vi.fn() }));
vi.mock('bullmq', () => ({ Worker: WorkerMock }));
vi.mock('axios', () => ({ default: { post: vi.fn() } }));
vi.mock('@/app/utils/push-notification.service', () => ({ sendPushNotification: vi.fn() }));
vi.mock('@/app/configs/redis.configs', () => ({ getRedisClient: () => ({ marker: 'redis' }) }));

import axios from 'axios';
import { logger } from '@/app/configs/logger.configs';
import { sendPushNotification } from '@/app/utils/push-notification.service';
import { createNotificationWorker } from '@/app/workers/notification.workers';

type Processor = (job: { id?: string; name?: string; data: any }) => Promise<unknown>;
let worker: { queue: string; processor: Processor; opts: any; on: ReturnType<typeof vi.fn> };
let processor: Processor;

const SERVER_URL = 'http://server.test:8080/api/v1'; // from vitest.config.mts

beforeEach(() => {
  WorkerMock.mockImplementation(function (this: any, queue: string, proc: Processor, opts: any) {
    this.queue = queue;
    this.processor = proc;
    this.opts = opts;
    this.on = vi.fn();
  });
  vi.mocked(sendPushNotification).mockResolvedValue({ success: true, messageId: 'm-1' });
  vi.mocked(axios.post).mockResolvedValue({ status: 201 });
  worker = createNotificationWorker() as any;
  processor = worker.processor;
});

const baseJob = (data: Record<string, unknown> = {}) => ({
  id: 'n1',
  name: 'send-notification',
  data: {
    userId: 'user-1',
    fcmToken: 'fcm-token-1',
    title: 'Ride accepted',
    message: 'Your driver is on the way',
    ...data,
  },
});

describe('createNotificationWorker wiring', () => {
  it('consumes "notification-queue" with 15 concurrent jobs on the shared Redis connection', () => {
    expect(worker.queue).toBe('notification-queue');
    expect(worker.opts).toEqual({ connection: { marker: 'redis' }, concurrency: 15 });
  });

  it('registers completed + failed listeners that log', () => {
    const on = (e: string) => worker.on.mock.calls.find((c) => c[0] === e)![1];
    on('completed')({ id: 'n9' });
    on('failed')({ id: 'n9' }, new Error('x'));
    on('failed')(undefined, new Error('y'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('n9'));
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});

describe('processing a job', () => {
  it('sends the push, then persists the in-app notification via the server API', async () => {
    const result = await processor(
      baseJob({ data: { modelType: 'Ride', reference: 'ride-77' }, traceId: 'trace-1' }),
    );

    expect(result).toEqual({ success: true });
    expect(sendPushNotification).toHaveBeenCalledWith({
      fcmToken: 'fcm-token-1',
      title: 'Ride accepted',
      body: 'Your driver is on the way',
      data: { modelType: 'Ride', reference: 'ride-77' },
    });
    expect(axios.post).toHaveBeenCalledWith(
      `${SERVER_URL}/notification`,
      {
        receiver: 'user-1',
        message: 'Ride accepted',
        description: 'Your driver is on the way',
        modelType: 'Ride',
        reference: 'ride-77',
        isRead: false,
      },
      { headers: { 'x-trace-id': 'trace-1', 'Content-Type': 'application/json' } },
    );
  });

  it('applies defaults: title "SplitRide" for the push, modelType GENERAL, reference null, data {}', async () => {
    await processor(baseJob({ title: undefined }));

    expect(sendPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'SplitRide', data: {} }),
    );
    const body = vi.mocked(axios.post).mock.calls[0][1] as any;
    expect(body.modelType).toBe('GENERAL');
    expect(body.reference).toBeNull();
  });

  it('LIMITATION: when the title is missing, the push says "SplitRide" but the stored notification has no title', async () => {
    await processor(baseJob({ title: undefined }));
    const body = vi.mocked(axios.post).mock.calls[0][1] as any;
    expect(body.message).toBeUndefined();
  });

  it('uses NO_TRACE_ID in the request header when the job carries no traceId', async () => {
    await processor(baseJob());
    const config = vi.mocked(axios.post).mock.calls[0][2] as any;
    expect(config.headers['x-trace-id']).toBe('NO_TRACE_ID');
  });

  describe('no device token', () => {
    it.each([undefined, null, ''])('skips push and persistence for fcmToken=%s', async (fcmToken) => {
      const result = await processor(baseJob({ fcmToken }));

      expect(result).toEqual({ success: false });
      expect(sendPushNotification).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('user-1'));
    });
  });

  describe('failure isolation', () => {
    it('does not persist a notification the user never received (push failed) and fails the job', async () => {
      vi.mocked(sendPushNotification).mockResolvedValue({ success: false });
      await expect(processor(baseJob())).rejects.toThrow('Push notification failed');
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('a failing persistence call is logged but does NOT fail the job (the push already went out)', async () => {
      vi.mocked(axios.post).mockRejectedValue(new Error('404'));

      await expect(processor(baseJob())).resolves.toEqual({ success: true });
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to save notification to DB',
        expect.any(Error),
      );
    });

    it('rethrows unexpected errors (push service crashing) so BullMQ can retry', async () => {
      const boom = new Error('firebase sdk crashed');
      vi.mocked(sendPushNotification).mockRejectedValue(boom);

      await expect(processor(baseJob())).rejects.toBe(boom);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('n1'), boom);
    });
  });
});

describe('FIXED BUGS (regression tests)', () => {
  // BUG-REPORT WORKER-2 | high | worker/src/app/workers/notification.workers.ts:42
  // The worker persists notifications by POSTing to `${SERVER_URL}/notifications`, but the server
  // mounts the notification router at `/notification` (singular) under /api/v1 (see
  // server/src/app/routes/index.ts). The URL 404s, the error is swallowed ("don't fail the job"),
  // so notifications that go through the worker queue are NEVER stored in the DB / history.
  // The test derives the expected path from the server's real route table, so it turns red-for-
  // the-right-reason when either side is fixed.
  it('BUG WORKER-2: the persistence URL must match the server notification route', async () => {
    const routes = readFileSync(
      fileURLToPath(new URL('../../../../server/src/app/routes/index.ts', import.meta.url)),
      'utf8',
    );
    const mount = /path:\s*'(\/notification[^']*)',\s*route:\s*NotificationRoutes/.exec(routes)?.[1];
    expect(mount).toBeDefined();

    await processor(baseJob());

    expect(vi.mocked(axios.post).mock.calls[0][0]).toBe(`${SERVER_URL}${mount}`);
  });

  // BUG-REPORT WORKER-3 | medium | notification.workers.ts:28-61 + push-notification.service.ts:30-38
  // sendPushNotification() swallows every FCM error and returns {success:false}; the processor
  // then still returns {success:true} and never throws => a transient FCM outage loses the push
  // (no BullMQ retry) while the job is reported as successful.
  it('BUG WORKER-3: a failed push must not be reported as success (so it can be retried)', async () => {
    vi.mocked(sendPushNotification).mockResolvedValue({ success: false });

    const outcome = await processor(baseJob()).catch((e) => ({ threw: e }));

    // acceptable fixes: throw (BullMQ retries) or at least report success:false
    expect(outcome).not.toEqual({ success: true });
  });

  // BUG-REPORT WORKER-4 | low | notification.workers.ts:23 vs server/src/app/queues/notification.queues.ts:55-62
  // The server producer puts the trace id in `data.metadata.traceId`; the worker reads
  // `data.traceId`, so correlation ids sent by the server are always lost (NO_TRACE_ID).
  it('BUG WORKER-4: the traceId the server sends in data.metadata.traceId is propagated', async () => {
    await processor(baseJob({ metadata: { traceId: 'trace-from-server', source: 'x' } }));

    const config = vi.mocked(axios.post).mock.calls[0][2] as any;
    expect(config.headers['x-trace-id']).toBe('trace-from-server');
  });
});
