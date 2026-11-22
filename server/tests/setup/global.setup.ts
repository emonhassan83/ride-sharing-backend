/**
 * Global per-test-file setup (see `setupFiles` in vitest.config.ts).
 *
 * Only infrastructure with *import-time side effects* or process-wide state is mocked
 * here. Everything business-related (models, Stripe, queues, ...) is mocked inside the
 * individual test files so each suite states its own assumptions explicitly.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import { fakeRedis } from '../helpers/fakeRedis';

// Redis: `getRedisClient()` returns the in-memory fake (state reset before each test).
// NOTE: plain functions (not vi.fn) so `mockReset` can never strip the implementation.
vi.mock('../../src/app/config/redis.config', () => ({
  getRedisClient: () => fakeRedis,
  initializeRedis: () => undefined,
  connectRedis: async () => undefined,
  disconnectRedis: async () => undefined,
}));

// Winston's DailyRotateFile transports create log files under ./winston at import time.
vi.mock('../../src/app/config/logger.config', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  errorLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// firebase-admin `cert()` throws without real credentials, and it initialises at import.
vi.mock('../../src/app/config/firebase.config', () => ({
  messaging: {
    send: vi.fn(),
    sendEach: vi.fn(),
    sendEachForMulticast: vi.fn(),
  },
  default: {},
}));

beforeEach(() => {
  fakeRedis.reset();
});

afterEach(() => {
  // A test that enabled fake timers must never leak them into the next test.
  vi.useRealTimers();
});
