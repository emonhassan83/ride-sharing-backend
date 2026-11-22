/**
 * Unit tests: `getEmailQueue` (producer side of the e-mail pipeline).
 *
 * CONTRACT with the worker package: the queue name below must equal the name the worker
 * consumes, otherwise e-mails (OTPs, password resets, KYC, support replies) are enqueued
 * but never sent. Consumer: worker/src/app/workers/email.workers.ts -> `new Worker('email-queue', ...)`.
 * The exhaustive server<->worker contract lives in tests/unit/queues/workerContract.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRedis } from '@tests/helpers/fakeRedis';

const bull = vi.hoisted(() => ({ queues: [] as any[] }));

vi.mock('bullmq', () => ({
  Queue: vi.fn(function (this: any, name: string, opts: any) {
    const queue = { name, opts, add: vi.fn(), close: vi.fn(), on: vi.fn() };
    bull.queues.push(queue);
    return queue;
  }),
  Worker: vi.fn(),
}));

/** Fresh module registry => fresh `_emailQueue` singleton for every test. */
const load = async () => {
  vi.resetModules();
  return import('@src/app/queues/email.queues');
};

beforeEach(() => {
  bull.queues.length = 0;
});

describe('getEmailQueue', () => {
  it("creates a BullMQ Queue named exactly 'email-queue' (the name the worker listens on)", async () => {
    const { getEmailQueue } = await load();

    const queue = getEmailQueue();

    expect(bull.queues).toHaveLength(1);
    expect(bull.queues[0].name).toBe('email-queue');
    expect(queue).toBe(bull.queues[0]);
  });

  it('is a lazy singleton: nothing is created at import, and repeated calls reuse one Queue', async () => {
    const { getEmailQueue } = await load();
    expect(bull.queues).toHaveLength(0);

    const first = getEmailQueue();
    const second = getEmailQueue();
    const third = getEmailQueue();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(bull.queues).toHaveLength(1);
  });

  it('shares the application Redis connection with the queue', async () => {
    const { getEmailQueue } = await load();
    getEmailQueue();
    expect(bull.queues[0].opts.connection).toBe(fakeRedis);
  });

  it('retries failed e-mail jobs 3 times with exponential back-off starting at 2s', async () => {
    const { getEmailQueue } = await load();
    getEmailQueue();

    const { attempts, backoff } = bull.queues[0].opts.defaultJobOptions;
    expect(attempts).toBe(3);
    expect(backoff).toEqual({ type: 'exponential', delay: 2000 });
  });

  it('removes completed jobs but KEEPS failed ones (so failures stay inspectable)', async () => {
    const { getEmailQueue } = await load();
    getEmailQueue();

    const opts = bull.queues[0].opts.defaultJobOptions;
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toBe(false);
  });

  it('a fresh module registry builds a separate queue (singleton is per module instance)', async () => {
    const a = (await load()).getEmailQueue();
    const b = (await load()).getEmailQueue();
    expect(b).not.toBe(a);
    expect(bull.queues).toHaveLength(2);
  });
});
