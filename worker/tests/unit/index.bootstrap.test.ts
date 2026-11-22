/**
 * Unit tests: worker process bootstrap + graceful shutdown (`src/index.ts`).
 *
 * index.ts has import-time side effects (signal handlers + `start()`), so every test re-imports it
 * with `vi.resetModules()` while `process.on` / `process.exit` are replaced by spies.
 */
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const { connectRedis, disconnectRedis, createEmailWorker, createNotificationWorker } = vi.hoisted(() => ({
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn(),
  createEmailWorker: vi.fn(),
  createNotificationWorker: vi.fn(),
}));
vi.mock('@/app/configs/redis.configs', () => ({ connectRedis, disconnectRedis }));
vi.mock('@/app/workers/email.workers', () => ({ createEmailWorker }));
vi.mock('@/app/workers/notification.workers', () => ({ createNotificationWorker }));

import { logger } from '@/app/configs/logger.configs';

let handlers: Record<string, (...args: any[]) => any>;
let exit: MockInstance<typeof process.exit>;
let emailWorker: { close: ReturnType<typeof vi.fn> };
let notificationWorker: { close: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.resetModules();
  handlers = {};
  vi.spyOn(process, 'on').mockImplementation(((event: string, fn: (...a: any[]) => any) => {
    handlers[event] = fn;
    return process;
  }) as any);
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

  emailWorker = { close: vi.fn(async () => undefined) };
  notificationWorker = { close: vi.fn(async () => undefined) };
  connectRedis.mockResolvedValue(undefined);
  disconnectRedis.mockResolvedValue(undefined);
  createEmailWorker.mockReturnValue(emailWorker);
  createNotificationWorker.mockReturnValue(notificationWorker);
});

const boot = async () => {
  await import('@/index');
  await vi.waitFor(() => expect(createNotificationWorker).toHaveBeenCalled());
};

describe('startup', () => {
  it('connects Redis BEFORE creating the workers, then creates both consumers', async () => {
    await boot();

    expect(connectRedis).toHaveBeenCalledTimes(1);
    expect(createEmailWorker).toHaveBeenCalledTimes(1);
    expect(createNotificationWorker).toHaveBeenCalledTimes(1);
    expect(connectRedis.mock.invocationCallOrder[0]).toBeLessThan(
      createEmailWorker.mock.invocationCallOrder[0],
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it('registers SIGTERM, SIGINT, uncaughtException and unhandledRejection handlers', async () => {
    await boot();
    expect(Object.keys(handlers).sort()).toEqual(
      ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].sort(),
    );
  });

  it('exits with code 1 when startup fails (e.g. Redis unreachable) and starts no worker', async () => {
    connectRedis.mockRejectedValue(new Error('ECONNREFUSED'));
    await import('@/index');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(createEmailWorker).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('[Worker] Failed to start', expect.anything());
  });
});

describe('graceful shutdown', () => {
  it.each(['SIGTERM', 'SIGINT'])('%s drains every worker, disconnects Redis, then exits 0', async (signal) => {
    await boot();

    await handlers[signal]();

    expect(emailWorker.close).toHaveBeenCalledTimes(1);
    expect(notificationWorker.close).toHaveBeenCalledTimes(1);
    expect(disconnectRedis).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    // Redis must only be closed AFTER in-flight jobs finished
    expect(emailWorker.close.mock.invocationCallOrder[0]).toBeLessThan(
      disconnectRedis.mock.invocationCallOrder[0],
    );
  });

  it('a second signal while shutting down is ignored (no double close)', async () => {
    await boot();

    await Promise.all([handlers.SIGTERM(), handlers.SIGINT()]);

    expect(emailWorker.close).toHaveBeenCalledTimes(1);
    expect(disconnectRedis).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when draining fails', async () => {
    await boot();
    emailWorker.close.mockRejectedValue(new Error('job stuck'));

    await handlers.SIGTERM();

    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).not.toHaveBeenCalledWith(0);
  });

  it('CHARACTERIZATION: if a worker fails to close, Redis is NOT disconnected before exiting 1', async () => {
    await boot();
    emailWorker.close.mockRejectedValue(new Error('job stuck'));

    await handlers.SIGTERM();

    expect(disconnectRedis).not.toHaveBeenCalled();
  });
});

describe('process-level error handlers', () => {
  it('log uncaught exceptions / unhandled rejections but keep the worker alive', async () => {
    await boot();

    handlers.uncaughtException(new Error('boom'));
    handlers.unhandledRejection('why');

    expect(logger.error).toHaveBeenCalledWith('[Worker] Uncaught exception', expect.anything());
    expect(logger.error).toHaveBeenCalledWith('[Worker] Unhandled rejection', { reason: 'why' });
    expect(exit).not.toHaveBeenCalled();
  });
});
