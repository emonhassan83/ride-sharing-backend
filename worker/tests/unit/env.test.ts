/**
 * Unit tests: worker environment loading (`src/env.ts`, `src/app/utils/env.utils.ts`).
 *
 * `env.ts` runs at import time: it validates required variables (throws when one is missing),
 * resolves the time zone (and writes it to process.env.TZ) and builds the typed `env` object.
 * Each test re-imports the module with `vi.resetModules()` + stubbed variables.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

const loadEnv = async () => (await import('@/env')).env;

describe('getEnv', () => {
  it('returns the value of a defined variable', async () => {
    vi.stubEnv('MY_VAR', 'hello');
    const { getEnv } = await import('@/app/utils/env.utils');
    expect(getEnv('MY_VAR')).toBe('hello');
  });

  it.each([undefined, ''])('throws "Missing Environment Variable" for %j', async (value) => {
    vi.stubEnv('MY_VAR', value as string);
    const { getEnv } = await import('@/app/utils/env.utils');
    expect(() => getEnv('MY_VAR')).toThrow('Missing Environment Variable: MY_VAR');
  });
});

describe('env object', () => {
  it('maps variables and converts ports to numbers', async () => {
    const env = await loadEnv();
    expect(env).toMatchObject({
      NODE_ENV: 'test',
      SMTP_HOST: 'smtp.test.local',
      SMTP_PORT: 587,
      REDIS_PORT: 6379,
      EMAIL_FROM: 'no-reply@test.local',
      SERVER_URL: 'http://server.test:8080/api/v1',
      S3_BUCKET_NAME: 'bucket',
    });
  });

  describe('SMTP_SECURE', () => {
    it('honours an explicit "true"', async () => {
      vi.stubEnv('SMTP_SECURE', 'true');
      expect((await loadEnv()).SMTP_SECURE).toBe(true);
    });

    it('honours an explicit "false", even on port 465', async () => {
      vi.stubEnv('SMTP_SECURE', 'false');
      vi.stubEnv('SMTP_PORT', '465');
      expect((await loadEnv()).SMTP_SECURE).toBe(false);
    });

    it('any other explicit value counts as false', async () => {
      vi.stubEnv('SMTP_SECURE', 'yes');
      expect((await loadEnv()).SMTP_SECURE).toBe(false);
    });

    it('defaults to true on the implicit-TLS port 465', async () => {
      vi.stubEnv('SMTP_SECURE', undefined as unknown as string);
      vi.stubEnv('SMTP_PORT', '465');
      expect((await loadEnv()).SMTP_SECURE).toBe(true);
    });

    it('defaults to false on STARTTLS port 587', async () => {
      vi.stubEnv('SMTP_SECURE', undefined as unknown as string);
      expect((await loadEnv()).SMTP_SECURE).toBe(false);
    });
  });

  describe('required variables', () => {
    it.each([
      'NODE_ENV',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USERNAME',
      'SMTP_PASSWORD',
      'EMAIL_FROM',
      'REDIS_HOST',
      'REDIS_PASSWORD',
      'REDIS_PORT',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'S3_REGION',
      'S3_BUCKET_NAME',
      'TIME_ZONE',
      'SERVER_URL',
    ])('refuses to start without %s', async (key) => {
      vi.stubEnv(key, undefined as unknown as string);
      await expect(loadEnv()).rejects.toThrow(`Missing Environment Variable: ${key}`);
    });
  });

  describe('time zone resolution (also written to process.env.TZ)', () => {
    it.each([
      ['Europe/Nicosia', 'Europe/Nicosia'],
      ['cyprus', 'Europe/Nicosia'],
      ['Nicosia', 'Europe/Nicosia'],
      ['Asia/Dhaka', 'Asia/Dhaka'],
      ['dhaka', 'Asia/Dhaka'],
      ['Bangladesh', 'Asia/Dhaka'],
      ['"Asia/Dhaka"', 'Asia/Dhaka'], // quotes from a .env line are stripped
      ["'cyprus'", 'Europe/Nicosia'],
      ['America/New_York', 'America/New_York'], // any valid IANA zone is accepted
      ['Not/AZone', 'Europe/Nicosia'], // invalid -> default
      ['   ', 'Europe/Nicosia'], // blank -> default
    ])('TIME_ZONE=%j -> %s', async (raw, expected) => {
      // blank is truthy for `process.env.TIME_ZONE ||`, so it is resolved (not required)
      vi.stubEnv('TIME_ZONE', raw);
      const env = await loadEnv();
      expect(env.timeZone).toBe(expected);
      expect(process.env.TZ).toBe(expected);
    });

    it('an EMPTY TIME_ZONE is treated as missing (startup error, not a silent default)', async () => {
      vi.stubEnv('TIME_ZONE', '');
      await expect(loadEnv()).rejects.toThrow('Missing Environment Variable: TIME_ZONE');
    });
  });
});

describe('configuration contract', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  // BUG-REPORT WORKER-6 | low | worker/.env.example
  // src/env.ts demands TIME_ZONE and SERVER_URL (getEnv throws without them) but the shipped
  // `.env.example` does not list them, so a worker configured from the example crashes at boot
  // with "Missing Environment Variable". Fix: add both to .env.example.
  describe('FIXED BUGS (regression tests)', () => {
    it('BUG WORKER-6: .env.example documents every variable src/env.ts requires', () => {
      const required = [...read('../../src/env.ts').matchAll(/getEnv\('([A-Z0-9_]+)'\)/g)].map((m) => m[1]);
      const documented = new Set(
        read('../../.env.example')
          .split(/\r?\n/)
          .map((l) => /^\s*([A-Z0-9_]+)\s*=/.exec(l)?.[1])
          .filter(Boolean),
      );
      const missing = [...new Set(required)].filter((k) => !documented.has(k));
      expect(missing).toEqual([]);
    });
  });
});
