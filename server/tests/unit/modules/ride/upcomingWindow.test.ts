/**
 * Issue 13: "previous day's ride is showing in the Upcoming section".
 * Times are wall-clock in the ride timezone (Europe/Nicosia, UTC+2 in November).
 */
import { describe, expect, it } from 'vitest';
import { isPastUpcomingWindow, UPCOMING_GRACE_MINUTES } from '@src/app/modules/ride/ride.service';

// 2026-11-23 10:00 Nicosia
const NOW = new Date('2026-11-23T08:00:00Z');

describe('isPastUpcomingWindow', () => {
  it('grace is 2 hours', () => {
    expect(UPCOMING_GRACE_MINUTES).toBe(120);
  });

  it.each([
    ['2026-11-22', '18:00', true, "yesterday's ride"],
    ['2026-11-22', '23:59', true, 'late last night'],
    ['2026-11-23', '07:30', true, 'this morning, 2.5 h ago (was still "upcoming": same day)'],
    ['2026-11-23', '08:30', false, '1.5 h ago, still inside the grace for a late driver'],
    ['2026-11-23', '14:00', false, 'later today'],
    ['2026-11-24', '09:00', false, 'tomorrow'],
    ['22/11/2026', '18:00', true, 'DD/MM/YYYY date format'],
  ])('%s %s -> %s (%s)', (date, time, past) => {
    expect(isPastUpcomingWindow(date, time, NOW)).toBe(past);
  });

  it('an unparseable time falls back to the calendar day', () => {
    expect(isPastUpcomingWindow('2026-11-22', 'soon', NOW)).toBe(true);
    expect(isPastUpcomingWindow('2026-11-23', 'soon', NOW)).toBe(false);
  });

  it('an unparseable date is never hidden', () => {
    expect(isPastUpcomingWindow('next week', '10:00', NOW)).toBe(false);
  });

  it('Bangladesh tester at 01:30 local (= 21:30 Nicosia): a ride at 20:00 Nicosia is now past', () => {
    const dhaka0130 = new Date('2026-11-22T19:30:00Z');
    expect(isPastUpcomingWindow('2026-11-22', '17:00', dhaka0130)).toBe(true);
  });
});
