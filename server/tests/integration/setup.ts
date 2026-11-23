/**
 * Integration setup: fake ONLY third-party services. MongoDB, Redis, Socket.io,
 * BullMQ and all app code are real.
 */
import { vi } from 'vitest';

// Firebase push: record what would be sent; report every token as delivered.
vi.mock('../../src/app/config/firebase.config', () => ({
  messaging: {
    send: vi.fn(),
    sendEach: vi.fn(async (messages: unknown[]) => ({
      successCount: messages.length,
      failureCount: 0,
      responses: messages.map(() => ({ success: true })),
    })),
    sendEachForMulticast: vi.fn(),
  },
  default: {},
}));

// Winston writes log files at import time.
vi.mock('../../src/app/config/logger.config', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  errorLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Google Maps (network): straight-line fallback values.
vi.mock('../../src/app/utils/maps.utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRealDistanceAndETA: vi.fn(async () => ({ distanceKm: 1, durationMinutes: 3 })),
  getRouteGeometry: vi.fn(async () => ({})),
}));
