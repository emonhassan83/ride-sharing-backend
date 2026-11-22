/**
 * Time-zone helpers.
 *
 * Production resolves the "ride" time zone from RIDE_TIME_ZONE / TIME_ZONE (default
 * Europe/Nicosia) and `getRideTimeZone()` also *assigns* `process.env.TZ` as a side
 * effect. Tests that switch zone must therefore stub TZ too, so the original value is
 * restored after the test (`unstubEnvs: true` in vitest.config.ts).
 */
import { vi } from 'vitest';

export const useRideTimeZone = (tz: string): void => {
  vi.stubEnv('RIDE_TIME_ZONE', tz);
  vi.stubEnv('TIME_ZONE', tz);
  vi.stubEnv('TZ', tz);
};

/**
 * Freeze "now". Pair with the global `afterEach(vi.useRealTimers)` in global.setup.ts.
 * Only `Date` is faked by default so promises / nextTick keep working normally.
 */
export const freezeTime = (iso: string): void => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};
