/**
 * Unit tests: getFareType (day / night classification of a departure instant).
 *
 * Day = 06:00:00–20:29:59, Night = 20:30:00–05:59:59, evaluated on the Cyprus ride clock.
 * Instants are chosen so the Nicosia wall clock is exact (winter UTC+2, summer UTC+3).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getFareType } from '@src/app/utils/time.utils';
import { freezeTime, useRideTimeZone } from '@tests/helpers/time';

describe('getFareType', () => {
  beforeEach(() => {
    useRideTimeZone('Europe/Nicosia');
  });

  describe('day/night boundaries (winter, UTC+2)', () => {
    it('returns night at 05:59:59 (last second of night)', () => {
      // 03:59:59Z = 05:59:59 Nicosia
      expect(getFareType(new Date('2026-01-15T03:59:59Z'))).toBe('night');
    });

    it('returns day at exactly 06:00:00 (first second of day)', () => {
      expect(getFareType(new Date('2026-01-15T04:00:00Z'))).toBe('day');
    });

    it('returns day at 20:29:59 (last second of day)', () => {
      expect(getFareType(new Date('2026-01-15T18:29:59Z'))).toBe('day');
    });

    it('returns night at exactly 20:30:00 (first second of night)', () => {
      expect(getFareType(new Date('2026-01-15T18:30:00Z'))).toBe('night');
    });

    it('returns night at midnight', () => {
      expect(getFareType(new Date('2026-01-14T22:00:00Z'))).toBe('night');
    });
  });

  describe('summer (UTC+3) uses the Cyprus wall clock, not UTC', () => {
    it('returns day at 06:00 Nicosia summer time (03:00Z)', () => {
      expect(getFareType(new Date('2026-07-15T03:00:00Z'))).toBe('day');
    });

    it('returns night at 05:59:59 Nicosia summer time (02:59:59Z)', () => {
      expect(getFareType(new Date('2026-07-15T02:59:59Z'))).toBe('night');
    });

    it('returns night at 20:30 Nicosia summer time (17:30Z) even though UTC is still day-ish', () => {
      // 17:30Z is 17:30 UTC; a UTC-based check would call it day.
      expect(getFareType(new Date('2026-07-15T17:30:00Z'))).toBe('night');
    });

    it('returns day at 20:29:59 Nicosia summer time (17:29:59Z)', () => {
      expect(getFareType(new Date('2026-07-15T17:29:59Z'))).toBe('day');
    });
  });

  it('follows the active ride time zone (Asia/Dhaka, UTC+6) rather than UTC', () => {
    useRideTimeZone('Asia/Dhaka');
    // 00:00Z = 06:00 Dhaka -> day
    expect(getFareType(new Date('2026-03-01T00:00:00Z'))).toBe('day');
    // 14:30Z = 20:30 Dhaka -> night
    expect(getFareType(new Date('2026-03-01T14:30:00Z'))).toBe('night');
  });

  it('classifies the frozen current time when called with no argument', () => {
    freezeTime('2026-11-22T12:00:00Z'); // 14:00 Nicosia
    expect(getFareType(new Date())).toBe('day');
  });
});
