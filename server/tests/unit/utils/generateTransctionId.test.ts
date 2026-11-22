/**
 * Unit tests: generateTransactionId (SplitRide-YYYYMMDD-NNNNN payment reference).
 * Date is frozen and Math.random is stubbed so the output is fully deterministic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateTransactionId } from '@src/app/utils/generateTransctionId';
import { freezeTime } from '@tests/helpers/time';

describe('generateTransactionId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds SplitRide-<date>-<5 digits> with the local (Europe/Nicosia) calendar date', () => {
    freezeTime('2026-03-20T10:00:00Z');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // random 0.5 -> floor(10000 + 45000) = 55000
    expect(generateTransactionId()).toBe('SplitRide-20260320-55000');
  });

  it('zero-pads single-digit month and day', () => {
    freezeTime('2026-01-05T12:00:00Z');
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(generateTransactionId()).toBe('SplitRide-20260105-10000');
  });

  it('uses the Nicosia calendar day, not the UTC day, around midnight', () => {
    // 2026-03-20T22:30Z is already 2026-03-21 00:30 in Europe/Nicosia (UTC+2 in March)
    freezeTime('2026-03-20T22:30:00Z');
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(generateTransactionId()).toBe('SplitRide-20260321-10000');
  });

  it('lower boundary: random 0 gives the 5-digit minimum 10000', () => {
    freezeTime('2026-12-31T09:00:00Z');
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(generateTransactionId()).toBe('SplitRide-20261231-10000');
  });

  it('upper boundary: random just below 1 gives the 5-digit maximum 99999', () => {
    freezeTime('2026-12-31T09:00:00Z');
    vi.spyOn(Math, 'random').mockReturnValue(0.9999999);

    expect(generateTransactionId()).toBe('SplitRide-20261231-99999');
  });

  it('always produces a 5-digit random part across the random range', () => {
    freezeTime('2026-06-01T08:00:00Z');
    for (const r of [0, 0.25, 0.73, 0.999999]) {
      vi.spyOn(Math, 'random').mockReturnValueOnce(r);
      const id = generateTransactionId();
      expect(id).toMatch(/^SplitRide-20260601-\d{5}$/);
    }
  });

  it('produces different ids for different random draws on the same day', () => {
    freezeTime('2026-06-01T08:00:00Z');
    const spy = vi.spyOn(Math, 'random');
    spy.mockReturnValueOnce(0.1).mockReturnValueOnce(0.2);

    expect(generateTransactionId()).not.toBe(generateTransactionId());
  });
});
