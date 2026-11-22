/**
 * Global per-test-file setup. Only things with import-time side effects are mocked here;
 * everything else is mocked in the individual test files.
 */
import { afterEach, vi } from 'vitest';

// winston's DailyRotateFile creates log files under ./winston at import time.
vi.mock('../../src/app/configs/logger.configs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  errorLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

afterEach(() => {
  vi.useRealTimers();
});
