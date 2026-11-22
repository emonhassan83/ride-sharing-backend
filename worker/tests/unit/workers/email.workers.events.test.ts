/**
 * Unit tests: BullMQ email worker lifecycle listeners when job data is missing.
 * Complements email.workers.test.ts (which covers the processor and the happy-path logging).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { WorkerMock } = vi.hoisted(() => ({ WorkerMock: vi.fn() }));
vi.mock('bullmq', () => ({ Worker: WorkerMock }));
vi.mock('@/app/configs/nodemailer.config', () => ({ sendEmail: vi.fn() }));
vi.mock('@/app/configs/redis.configs', () => ({ getRedisClient: () => ({ marker: 'redis' }) }));

import { logger } from '@/app/configs/logger.configs';
import { createEmailWorker } from '@/app/workers/email.workers';

let listeners: Record<string, (...args: any[]) => void>;

beforeEach(() => {
  listeners = {};
  WorkerMock.mockImplementation(function (this: any) {
    this.on = vi.fn((event: string, cb: (...args: any[]) => void) => {
      listeners[event] = cb;
    });
  });
  createEmailWorker();
});

describe('email worker completed listener', () => {
  it('uses NO_TRACE_ID when the completed job has no data at all', () => {
    expect(() => listeners.completed({ id: '1', name: 'send-verification-email', data: undefined })).not.toThrow();
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.stringContaining('Job Name : send-verification-email Job Id : 1 Completed')
    );
  });

  it('uses NO_TRACE_ID when data is present but has no traceId', () => {
    listeners.completed({ id: '2', name: 'send-kyc-verified-email', data: {} });
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(expect.stringContaining('Job Id : 2 Completed'));
  });
});
