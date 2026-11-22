/**
 * Unit tests: BullMQ email consumer (`email-queue`).
 *
 * The server enqueues jobs named send-verification-email / send-reset-password-email /
 * send-kyc-verified-email / send-kyc-rejected-email / send-support-reply-email; this worker
 * renders the matching Handlebars template and hands it to `sendEmail`.
 *
 * Real code under test: the processor, the five templates and Handlebars (so HTML-escaping of
 * user-controlled values is verified for real). Mocked: BullMQ `Worker`, SMTP `sendEmail`, Redis.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { WorkerMock } = vi.hoisted(() => ({ WorkerMock: vi.fn() }));
vi.mock('bullmq', () => ({ Worker: WorkerMock }));
vi.mock('@/app/configs/nodemailer.config', () => ({ sendEmail: vi.fn() }));
// plain function (not vi.fn) so `mockReset` can never strip it
vi.mock('@/app/configs/redis.configs', () => ({ getRedisClient: () => ({ marker: 'redis' }) }));

import { logger } from '@/app/configs/logger.configs';
import { sendEmail } from '@/app/configs/nodemailer.config';
import { getTraceId } from '@/app/configs/requestContext.configs';
import { createEmailWorker } from '@/app/workers/email.workers';

type Processor = (job: { id?: string; name: string; data: any }) => Promise<unknown>;

let worker: { queue: string; processor: Processor; opts: any; on: ReturnType<typeof vi.fn> };
let processor: Processor;

beforeEach(() => {
  WorkerMock.mockImplementation(function (this: any, queue: string, proc: Processor, opts: any) {
    this.queue = queue;
    this.processor = proc;
    this.opts = opts;
    this.on = vi.fn();
  });
  vi.mocked(sendEmail).mockResolvedValue(undefined);
  worker = createEmailWorker() as any;
  processor = worker.processor;
});

const sentMail = () => vi.mocked(sendEmail).mock.calls[0][0];

describe('createEmailWorker wiring', () => {
  it('consumes the "email-queue" queue with the shared Redis connection', () => {
    expect(worker.queue).toBe('email-queue');
    expect(worker.opts).toEqual({ connection: { marker: 'redis' } });
  });

  it('registers completed and failed listeners', () => {
    const events = worker.on.mock.calls.map((c) => c[0]);
    expect(events).toEqual(expect.arrayContaining(['completed', 'failed']));
  });
});

describe('job routing + template rendering', () => {
  it('send-verification-email: OTP mail to data.email', async () => {
    await processor({
      id: 'j1',
      name: 'send-verification-email',
      data: { email: 'rider@example.com', name: 'Maria', otp: '482913', expiresAt: 'ignored' },
    });

    const mail = sentMail();
    expect(mail.to).toBe('rider@example.com');
    expect(mail.subject).toBe('Your One-Time OTP');
    expect(mail.html).toContain('Email Verification');
    expect(mail.html).toContain('Maria');
    expect(mail.html).toContain('482913');
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('send-reset-password-email: uses the reset template, not the verification one', async () => {
    await processor({
      id: 'j2',
      name: 'send-reset-password-email',
      data: { email: 'rider@example.com', name: 'Maria', otp: '111222' },
    });

    const mail = sentMail();
    expect(mail.subject).toBe('Your One-Time OTP');
    expect(mail.html).toContain('Password Reset Request');
    expect(mail.html).not.toContain('Email Verification');
    expect(mail.html).toContain('111222');
  });

  it('send-kyc-verified-email: approval mail showing the account email', async () => {
    await processor({
      id: 'j3',
      name: 'send-kyc-verified-email',
      data: { email: 'driver@example.com', name: 'Andreas' },
    });

    const mail = sentMail();
    expect(mail.to).toBe('driver@example.com');
    expect(mail.subject).toBe('✅ Your KYC Verification Has Been Approved!');
    expect(mail.html).toContain('KYC Verification Approved');
    expect(mail.html).toContain('Andreas');
    expect(mail.html).toContain('driver@example.com');
  });

  it('send-kyc-rejected-email: rejection mail carrying the reason', async () => {
    await processor({
      id: 'j4',
      name: 'send-kyc-rejected-email',
      data: { email: 'driver@example.com', name: 'Andreas', reason: 'Driving licence is blurry' },
    });

    const mail = sentMail();
    expect(mail.subject).toBe('❌ Your KYC Verification Was Not Approved');
    expect(mail.html).toContain('KYC Verification Update');
    expect(mail.html).toContain('Driving licence is blurry');
  });

  describe('send-support-reply-email', () => {
    const support = { id: 'SUP-123', email: 'rider@example.com' };

    it('mails the ticket owner (support.email) with subject + message + ticket id', async () => {
      await processor({
        id: 'j5',
        name: 'send-support-reply-email',
        data: { support, subj: 'Refund status', messages: 'We refunded EUR 12.50.' },
      });

      const mail = sentMail();
      expect(mail.to).toBe('rider@example.com');
      expect(mail.subject).toBe('Support Message: Refund status');
      expect(mail.html).toContain('We refunded EUR 12.50.');
      expect(mail.html).toContain('SUP-123');
      expect(mail.html).toContain('no-reply@test.local'); // fromEmail = env.EMAIL_FROM
    });

    it('accepts the alternative field names `subject` / `message`', async () => {
      await processor({
        id: 'j6',
        name: 'send-support-reply-email',
        data: { support, subject: 'Alt subject', message: 'Alt body' },
      });
      expect(sentMail().subject).toBe('Support Message: Alt subject');
      expect(sentMail().html).toContain('Alt body');
    });

    it('falls back to "Support Reply" and an empty body when neither is provided', async () => {
      await processor({ id: 'j7', name: 'send-support-reply-email', data: { support } });
      expect(sentMail().subject).toBe('Support Message: Support Reply');
    });

    it('prefers an explicit data.email over support.email as the recipient', async () => {
      await processor({
        id: 'j8',
        name: 'send-support-reply-email',
        data: { support, email: 'override@example.com', subj: 's', messages: 'm' },
      });
      expect(sentMail().to).toBe('override@example.com');
    });

    it('LIMITATION: line breaks in the reply are not converted to <br> (multi-line replies collapse in HTML)', async () => {
      await processor({
        id: 'j9',
        name: 'send-support-reply-email',
        data: { support, subj: 's', messages: 'line one\nline two' },
      });
      expect(sentMail().html).toContain('line one\nline two');
      expect(sentMail().html).not.toContain('line one<br>');
    });
  });
});

describe('HTML escaping of user-controlled values (stored-XSS / HTML-injection guard)', () => {
  const payload = '<img src=x onerror=alert(1)>';

  it.each([
    ['send-verification-email', { email: 'a@b.c', name: payload, otp: '1' }],
    ['send-reset-password-email', { email: 'a@b.c', name: payload, otp: '1' }],
    ['send-kyc-verified-email', { email: 'a@b.c', name: payload }],
    ['send-kyc-rejected-email', { email: 'a@b.c', name: 'n', reason: payload }],
    ['send-support-reply-email', { support: { id: '1', email: 'a@b.c' }, subj: payload, messages: payload }],
  ])('%s never emits raw HTML from job data', async (name, data) => {
    await processor({ id: 'x', name, data });
    const html = sentMail().html;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('failure handling', () => {
  it('rejects an unknown job name and sends nothing', async () => {
    await expect(
      processor({ id: 'j10', name: 'send-newsletter', data: { email: 'a@b.c' } }),
    ).rejects.toThrow('Unhandled email job: send-newsletter');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['send-verification-email', { name: 'M', otp: '1' }],
    ['send-kyc-verified-email', { name: 'M' }],
    ['send-support-reply-email', { subj: 's', messages: 'm' }],
    ['send-support-reply-email', { support: {}, subj: 's', messages: 'm' }],
  ])('%s without any recipient fails the job (no mail to "undefined")', async (name, data) => {
    await expect(processor({ id: 'j11', name, data })).rejects.toThrow(
      'Recipient email is missing in job data',
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('logs and rethrows when sending fails so BullMQ can retry', async () => {
    const boom = new Error('SMTP down');
    vi.mocked(sendEmail).mockRejectedValue(boom);

    await expect(
      processor({
        id: 'j12',
        name: 'send-verification-email',
        data: { email: 'a@b.c', name: 'M', otp: '1' },
      }),
    ).rejects.toBe(boom);

    expect(logger.error).toHaveBeenCalledWith(
      'Worker job failed',
      expect.objectContaining({ jobName: 'send-verification-email', jobId: 'j12', error: boom }),
    );
  });
});

describe('trace id propagation', () => {
  const traceSeenBySend = async (data: Record<string, unknown>) => {
    let seen = '';
    vi.mocked(sendEmail).mockImplementation(async () => {
      seen = getTraceId();
    });
    await processor({
      id: 't',
      name: 'send-kyc-verified-email',
      data: { email: 'a@b.c', name: 'n', ...data },
    });
    return seen;
  };

  it('runs the job inside a request context carrying data.traceId', async () => {
    expect(await traceSeenBySend({ traceId: 'trace-42' })).toBe('trace-42');
  });

  it('falls back to NO_TRACE_ID when the job has none', async () => {
    expect(await traceSeenBySend({})).toBe('NO_TRACE_ID');
  });

  it('keeps concurrent jobs isolated (no trace id bleed)', async () => {
    const seen: Record<string, string> = {};
    vi.mocked(sendEmail).mockImplementation(async (mail) => {
      await new Promise((r) => setTimeout(r, mail.to === 'slow@x.y' ? 20 : 1));
      seen[mail.to] = getTraceId();
    });
    await Promise.all([
      processor({ id: 'a', name: 'send-kyc-verified-email', data: { email: 'slow@x.y', name: 'n', traceId: 'T-slow' } }),
      processor({ id: 'b', name: 'send-kyc-verified-email', data: { email: 'fast@x.y', name: 'n', traceId: 'T-fast' } }),
    ]);
    expect(seen).toEqual({ 'slow@x.y': 'T-slow', 'fast@x.y': 'T-fast' });
  });
});

describe('event listeners', () => {
  const listener = (event: string) =>
    worker.on.mock.calls.find((c) => c[0] === event)![1] as (...args: any[]) => void;

  it('completed: logs job name and id', () => {
    listener('completed')({ id: '9', name: 'send-verification-email', data: { traceId: 't' } });
    expect(logger.info).toHaveBeenCalledWith('Job Name : send-verification-email Job Id : 9 Completed');
  });

  it('failed: logs job name, id and error', () => {
    listener('failed')({ id: '9', name: 'send-verification-email', data: {} }, new Error('nope'));
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Job Name : send-verification-email Job Id : 9 Failed'),
    );
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('nope'));
  });

  it('failed with no job object (stalled/removed job) does not crash and says so', () => {
    expect(() => listener('failed')(undefined, new Error('stalled'))).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('A job failed but the job data is undefined'),
    );
  });
});
