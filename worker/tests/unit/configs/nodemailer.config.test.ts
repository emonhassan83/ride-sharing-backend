/**
 * Unit tests: SMTP transport options + `sendEmail` (src/app/configs/nodemailer.config.ts).
 * (The "SMTP failure is swallowed so the job never retries" defect, WORKER-1, is exercised through
 * the worker in workers/email.workers.smtp.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createTransport, sendMail } = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}));
vi.mock('nodemailer', () => ({ createTransport }));

import { errorLogger, logger } from '@/app/configs/logger.configs';

beforeEach(() => {
  vi.resetModules();
  createTransport.mockImplementation(() => ({ sendMail }));
});

const load = () => import('@/app/configs/nodemailer.config');

describe('transport configuration', () => {
  it('builds the SMTP transport from the validated env', async () => {
    await load();
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.test.local',
      port: 587,
      secure: false,
      auth: { user: 'smtp-user', pass: 'smtp-pass' },
    });
  });

  it('uses implicit TLS when SMTP_SECURE=true', async () => {
    vi.stubEnv('SMTP_SECURE', 'true');
    await load();
    expect(createTransport.mock.calls[0][0].secure).toBe(true);
  });
});

describe('sendEmail', () => {
  it('sends from EMAIL_FROM with the given recipient, subject and html and logs the accepted list', async () => {
    sendMail.mockResolvedValue({ accepted: ['rider@example.com'] });
    const { sendEmail } = await load();

    await sendEmail({ to: 'rider@example.com', subject: 'Hi', html: '<p>x</p>' });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'no-reply@test.local',
      to: 'rider@example.com',
      subject: 'Hi',
      html: '<p>x</p>',
    });
    expect(logger.info).toHaveBeenCalledWith('Mail sent successfully', ['rider@example.com']);
  });

  it('does not log success when sending failed: it records the error and rethrows it', async () => {
    const err = new Error('550 mailbox unavailable');
    sendMail.mockRejectedValue(err);
    const { sendEmail } = await load();

    await expect(sendEmail({ to: 'x@y.z', subject: 's', html: 'h' })).rejects.toBe(err);

    expect(logger.info).not.toHaveBeenCalled();
    expect(errorLogger.error).toHaveBeenCalledWith('Email', err);
  });
});
