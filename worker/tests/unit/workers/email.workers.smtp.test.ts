/**
 * Integration-style test: email worker + the REAL nodemailer config (only the SMTP transport and
 * BullMQ are faked). Verifies what happens to a job when the SMTP server is unavailable.
 *
 * BullMQ only retries a job when its processor THROWS (queue defaults: attempts 3, exponential
 * backoff). `sendEmail` catches every SMTP error and logs it, so the processor never sees it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { WorkerMock, sendMail } = vi.hoisted(() => ({ WorkerMock: vi.fn(), sendMail: vi.fn() }));
vi.mock('bullmq', () => ({ Worker: WorkerMock }));
vi.mock('nodemailer', () => ({ createTransport: () => ({ sendMail }) }));
vi.mock('@/app/configs/redis.configs', () => ({ getRedisClient: () => ({}) }));

import { errorLogger } from '@/app/configs/logger.configs';
import { createEmailWorker } from '@/app/workers/email.workers';

let processor: (job: any) => Promise<unknown>;

beforeEach(() => {
  WorkerMock.mockImplementation(function (this: any, _q: string, proc: any) {
    this.processor = proc;
    this.on = vi.fn();
  });
  processor = (createEmailWorker() as any).processor;
});

const otpJob = {
  id: 'j1',
  name: 'send-verification-email',
  data: { email: 'rider@example.com', name: 'Maria', otp: '482913' },
};

describe('email worker with the real sendEmail', () => {
  it('delivers through SMTP with the configured sender', async () => {
    sendMail.mockResolvedValue({ accepted: ['rider@example.com'] });

    await processor(otpJob);

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'no-reply@test.local',
        to: 'rider@example.com',
        subject: 'Your One-Time OTP',
        html: expect.stringContaining('482913'),
      }),
    );
  });

  // BUG-REPORT WORKER-1 | high | worker/src/app/configs/nodemailer.config.ts:21-28
  // sendEmail() wraps transporter.sendMail in try/catch and only logs. A transient SMTP outage
  // therefore completes the job "successfully": the OTP / KYC / support mail is silently lost
  // and BullMQ never retries (the retry policy only triggers on a thrown error).
  // Fix: rethrow after logging (or drop the try/catch) so the job fails and is retried.
  describe('FIXED BUGS (regression tests)', () => {
    it('BUG WORKER-1: an SMTP failure must fail the job so BullMQ retries it', async () => {
      sendMail.mockRejectedValue(new Error('connect ETIMEDOUT smtp.test.local:587'));

      await expect(processor(otpJob)).rejects.toThrow('ETIMEDOUT');
    });
  });

  it('the SMTP error is also recorded in the error logger', async () => {
    sendMail.mockRejectedValue(new Error('connect ETIMEDOUT'));

    await expect(processor(otpJob)).rejects.toThrow('ETIMEDOUT');
    expect(errorLogger.error).toHaveBeenCalledWith('Email', expect.any(Error));
  });
});
