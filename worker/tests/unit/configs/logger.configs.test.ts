/**
 * Unit tests: winston logger wiring (`logger.configs.ts`).
 *
 * The global setup mocks this module (it creates log files at import). Here it is un-mocked so
 * the real wiring is checked, while the rotating file transport is replaced by a recorder so no
 * file is written to disk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const { RotateCtor } = vi.hoisted(() => ({ RotateCtor: vi.fn() }));

vi.mock('winston-daily-rotate-file', async () => {
  // Extend winston's own Transport base so winston accepts the fake as a real transport.
  const { default: Transport } = await import('winston-transport');
  return {
    default: class FakeRotate extends Transport {
      constructor(opts: any) {
        super(opts);
        RotateCtor(opts);
      }
      // No-op write: keeps the file system untouched.
      log(_info: unknown, callback: () => void) {
        callback();
      }
    },
  };
});

vi.unmock('@/app/configs/logger.configs');

type Loaded = typeof import('@/app/configs/logger.configs');

let mod: Loaded;

beforeEach(async () => {
  vi.resetModules();
  RotateCtor.mockClear();
  mod = await import('@/app/configs/logger.configs');
});

describe('logger.configs', () => {
  it('exports a info-level logger and an error-level logger', () => {
    expect(mod.logger.level).toBe('info');
    expect(mod.errorLogger.level).toBe('error');
  });

  it('each logger has a console transport and a daily-rotating file transport', () => {
    expect(mod.logger.transports).toHaveLength(2);
    expect(mod.errorLogger.transports).toHaveLength(2);
  });

  it('writes success logs under <cwd>/winston/success with the hourly date pattern', () => {
    const successCall = RotateCtor.mock.calls.find(([o]) => String(o.filename).includes('success'));
    expect(successCall).toBeDefined();
    const opts = successCall![0];
    expect(opts.filename).toBe(path.join(process.cwd(), 'winston', 'success', '%DATE%-success.log'));
    expect(opts.datePattern).toBe('DD-MM-YYYY-HH');
    expect(opts.maxSize).toBe('20m');
    expect(opts.maxFiles).toBe('1d');
  });

  it('writes error logs under <cwd>/winston/error', () => {
    const errorCall = RotateCtor.mock.calls.find(([o]) => String(o.filename).includes('error'));
    expect(errorCall).toBeDefined();
    expect(errorCall![0].filename).toBe(path.join(process.cwd(), 'winston', 'error', '%DATE%-error.log'));
  });

  it('error logger does not forward info messages (level filter)', () => {
    expect(mod.errorLogger.isLevelEnabled('info')).toBe(false);
    expect(mod.errorLogger.isLevelEnabled('error')).toBe(true);
  });
});
