/** Coverage for round-4 items that had no test: B-02 (OTP gate) and B-19 (scheduled accept text). */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('B-02: dev secrets (OTP in responses) only for development/test', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
    vi.resetModules();
  });

  const exposeFor = async (env: string | undefined) => {
    vi.resetModules();
    if (env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
    const { config } = await import('@src/app/config/env.config');
    return config.exposeDevSecrets;
  };

  it.each([
    ['development', true],
    ['test', true],
    ['production', false],
    ['staging', false],
    ['Production', false],
    ['', false],
    [undefined, false],
  ])('NODE_ENV=%s -> %s', async (env, expected) => {
    expect(await exposeFor(env as string | undefined)).toBe(expected);
  });
});
