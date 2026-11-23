/**
 * Unit tests: ride clock, departure-date parsing, minimum lead time / distance / refund windows.
 *
 * Time zones: the ride zone is Europe/Nicosia (UTC+2 winter, UTC+3 summer) unless a test switches
 * to Asia/Dhaka (UTC+6). "Now" is always frozen with freezeTime; nothing reads the real clock.
 * Settings are read through the mocked Setting model; each test provides its own key/value map.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockQuery } from '@tests/helpers/mongoose';
import { freezeTime, useRideTimeZone } from '@tests/helpers/time';
import { Setting } from '@src/app/modules/settings/settings.model';
import {
  DEFAULT_PRIVATE_MIN_BOOKING_HOURS,
  DEFAULT_PRIVATE_REFUND_RESTRICTION_HOURS,
  DEFAULT_SPLIT_MIN_BOOKING_HOURS,
  DEFAULT_SPLIT_MIN_DISTANCE_KM,
  DEFAULT_SPLIT_REFUND_RESTRICTION_HOURS,
  assertMinimumBookingLeadTime,
  assertSplitMinimumDistance,
  formatRideLocalDate,
  getDepartureDateTime,
  getHoursUntilDeparture,
  getMatchingLastNotifyHours,
  getMinBookingLeadHours,
  getRefundRestrictionHours,
  getRideLocalTimeParts,
  getRideTimeZone,
  getSplitMinDistanceKm,
} from '@src/app/utils/rideSchedule.utils';

vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
});

/** Route Setting.findOne by key; keys absent from the map return no document. */
const useSettings = (values: Record<string, unknown>) => {
  vi.mocked(Setting.findOne).mockImplementation(((filter: { key: string }) =>
    mockQuery(
      filter.key in values ? { key: filter.key, value: values[filter.key] } : null,
    )) as any);
};

/** Captures an ApiError thrown synchronously or by a rejected promise. */
const errorOf = async (fn: () => unknown): Promise<{ code: number; message: string }> => {
  try {
    await fn();
  } catch (err) {
    return err as { code: number; message: string };
  }
  throw new Error('expected function to throw');
};

describe('getRideTimeZone', () => {
  it('defaults to Europe/Nicosia from the test environment', () => {
    expect(getRideTimeZone()).toBe('Europe/Nicosia');
  });

  it('prefers RIDE_TIME_ZONE over TIME_ZONE', () => {
    vi.stubEnv('RIDE_TIME_ZONE', 'Asia/Dhaka');
    vi.stubEnv('TIME_ZONE', 'Europe/Nicosia');
    expect(getRideTimeZone()).toBe('Asia/Dhaka');
  });

  it('falls back to TIME_ZONE when RIDE_TIME_ZONE is empty', () => {
    vi.stubEnv('RIDE_TIME_ZONE', '');
    vi.stubEnv('TIME_ZONE', 'Asia/Dhaka');
    expect(getRideTimeZone()).toBe('Asia/Dhaka');
  });

  it('maps the Bangladesh aliases to Asia/Dhaka', () => {
    vi.stubEnv('RIDE_TIME_ZONE', 'Dhaka');
    expect(getRideTimeZone()).toBe('Asia/Dhaka');
    vi.stubEnv('RIDE_TIME_ZONE', 'bangladesh');
    expect(getRideTimeZone()).toBe('Asia/Dhaka');
  });

  it('maps the Cyprus aliases to Europe/Nicosia (case-insensitive, quotes stripped)', () => {
    vi.stubEnv('RIDE_TIME_ZONE', '  "Cyprus" ');
    expect(getRideTimeZone()).toBe('Europe/Nicosia');
  });

  it('assigns process.env.TZ to the resolved zone as a side effect', () => {
    useRideTimeZone('Asia/Dhaka');
    getRideTimeZone();
    expect(process.env.TZ).toBe('Asia/Dhaka');
  });

  it('falls back to Europe/Nicosia for an unknown zone name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('RIDE_TIME_ZONE', 'Mars/Olympus');
    expect(getRideTimeZone()).toBe('Europe/Nicosia');
    expect(warn).toHaveBeenCalled();
  });
});

describe('formatRideLocalDate', () => {
  it('returns the Nicosia calendar date, rolled forward at local midnight (summer, UTC+3)', () => {
    // 21:00Z = 00:00 Nicosia on 1 July
    expect(formatRideLocalDate(new Date('2026-06-30T21:00:00Z'))).toBe('2026-07-01');
  });

  it('stays on the previous date one second before Nicosia midnight', () => {
    expect(formatRideLocalDate(new Date('2026-06-30T20:59:59Z'))).toBe('2026-06-30');
  });

  it('uses UTC+2 in winter (22:00Z = midnight Nicosia)', () => {
    expect(formatRideLocalDate(new Date('2026-01-14T22:00:00Z'))).toBe('2026-01-15');
    expect(formatRideLocalDate(new Date('2026-01-14T21:59:59Z'))).toBe('2026-01-14');
  });

  it('uses the Dhaka date when the ride zone is Asia/Dhaka (18:00Z = midnight Dhaka)', () => {
    useRideTimeZone('Asia/Dhaka');
    expect(formatRideLocalDate(new Date('2026-06-30T18:00:00Z'))).toBe('2026-07-01');
    expect(formatRideLocalDate(new Date('2026-06-30T17:59:59Z'))).toBe('2026-06-30');
  });

  it('defaults to the frozen current time when no date is given', () => {
    freezeTime('2026-11-22T12:00:00Z');
    expect(formatRideLocalDate()).toBe('2026-11-22');
  });
});

describe('getRideLocalTimeParts', () => {
  it('returns hour 0 (not 24) at Nicosia midnight', () => {
    expect(getRideLocalTimeParts(new Date('2026-01-14T22:00:00Z'))).toEqual({
      hour: 0,
      minute: 0,
      second: 0,
    });
  });

  it('returns 23:59:59 one second before midnight', () => {
    expect(getRideLocalTimeParts(new Date('2026-01-14T21:59:59Z'))).toEqual({
      hour: 23,
      minute: 59,
      second: 59,
    });
  });

  it('returns the summer Nicosia wall clock (UTC+3)', () => {
    expect(getRideLocalTimeParts(new Date('2026-07-15T17:30:00Z'))).toEqual({
      hour: 20,
      minute: 30,
      second: 0,
    });
  });

  it('returns the Dhaka wall clock when the ride zone is Asia/Dhaka', () => {
    useRideTimeZone('Asia/Dhaka');
    expect(getRideLocalTimeParts(new Date('2026-01-15T00:00:00Z'))).toEqual({
      hour: 6,
      minute: 0,
      second: 0,
    });
  });
});

describe('getDepartureDateTime', () => {
  it('converts a winter Nicosia wall clock to UTC (09:30 UTC+2 = 07:30Z)', () => {
    expect(getDepartureDateTime('2026-01-15', '09:30').toISOString()).toBe('2026-01-15T07:30:00.000Z');
  });

  it('converts a summer Nicosia wall clock to UTC (09:30 UTC+3 = 06:30Z)', () => {
    expect(getDepartureDateTime('2026-07-15', '09:30').toISOString()).toBe('2026-07-15T06:30:00.000Z');
  });

  it('converts using the Dhaka offset when the ride zone is Asia/Dhaka (09:30 UTC+6 = 03:30Z)', () => {
    useRideTimeZone('Asia/Dhaka');
    expect(getDepartureDateTime('2026-01-15', '09:30').toISOString()).toBe('2026-01-15T03:30:00.000Z');
  });

  it('maps 00:00 to the start of the same local day', () => {
    expect(getDepartureDateTime('2026-01-15', '00:00').toISOString()).toBe('2026-01-14T22:00:00.000Z');
  });

  it('maps 23:59 to the last minute of the local day', () => {
    expect(getDepartureDateTime('2026-01-15', '23:59').toISOString()).toBe('2026-01-15T21:59:00.000Z');
  });

  it('maps 24:00 to 00:00 of the next local day', () => {
    expect(getDepartureDateTime('2026-01-15', '24:00').toISOString()).toBe('2026-01-15T22:00:00.000Z');
  });

  it('rolls 24:00 on the last day of a month into the next month', () => {
    expect(getDepartureDateTime('2026-01-31', '24:00').toISOString()).toBe('2026-01-31T22:00:00.000Z');
    expect(getDepartureDateTime('2026-12-31', '24:00').toISOString()).toBe('2026-12-31T22:00:00.000Z');
  });

  it('accepts an explicit seconds component in the time string (seconds ignored)', () => {
    expect(getDepartureDateTime('2026-01-15', '09:30:45').toISOString()).toBe('2026-01-15T07:30:00.000Z');
  });

  it.each([
    ['24:30', 'hour 24 with non-zero minutes'],
    ['23:60', 'minute 60'],
    ['-1:00', 'negative hour'],
    ['ab:cd', 'non-numeric time'],
  ])('rejects departureTime %p (%s) with 400', async (time) => {
    const err = await errorOf(() => getDepartureDateTime('2026-01-15', time));
    expect(err.code).toBe(400);
    expect(err.message).toBe('Invalid departureDate or departureTime');
  });

  it.each([['not-a-date'], [''], ['2026-01'], ['abcd-01-01']])(
    'rejects malformed departureDate %p with 400',
    async (date) => {
      const err = await errorOf(() => getDepartureDateTime(date, '09:00'));
      expect(err.code).toBe(400);
      expect(err.message).toBe('Invalid departureDate or departureTime');
    },
  );

  it('keeps the exact instant on the spring-forward day for a time after the gap (04:30 EEST = 01:30Z)', () => {
    // Nicosia jumps 03:00 -> 04:00 on 2026-03-29 at 01:00Z.
    expect(getDepartureDateTime('2026-03-29', '04:30').toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('CHARACTERIZATION: a wall-clock time inside the spring-forward gap (03:30) is shifted to 04:30 local', () => {
    // 03:30 does not exist on 2026-03-29 in Nicosia. The iterative alignment settles on 01:30Z (04:30 EEST),
    // so a booking entered at 03:30 is silently moved one hour later.
    expect(getDepartureDateTime('2026-03-29', '03:30').toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('CHARACTERIZATION: an ambiguous fall-back time (03:30 on 2026-10-25) resolves to the later instant (EET)', () => {
    // 03:30 happens twice; the function returns the second occurrence (01:30Z = 03:30 EET).
    expect(getDepartureDateTime('2026-10-25', '03:30').toISOString()).toBe('2026-10-25T01:30:00.000Z');
  });
});

describe('FIXED BUGS (regression tests) - rideSchedule.utils', () => {
  // BUG-REPORT FARE-03 | medium | server/src/app/utils/rideSchedule.utils.ts:83
  // Only the presence of year/month/day is checked. Date.UTC rolls '2026-02-30' into 2 March (07:00Z
  // for 09:00) and '2026-13-01' into 1 January 2027, so an impossible booking date is accepted.
  // Fix: round-trip the calendar components and throw the same 400 when they differ.
  it('BUG FARE-03: rejects an impossible calendar date (2026-02-30) with 400', async () => {
    await expect(errorOf(() => getDepartureDateTime('2026-02-30', '09:00'))).resolves.toMatchObject({
      code: 400,
    });
  });

  it('BUG FARE-03: rejects a month of 13 with 400 instead of rolling into 2027', async () => {
    await expect(errorOf(() => getDepartureDateTime('2026-13-01', '09:00'))).resolves.toMatchObject({
      code: 400,
    });
  });

  // BUG-REPORT FARE-04 | medium | server/src/app/utils/rideSchedule.utils.ts:84
  // A departureTime without minutes ('09' or '') leaves minute undefined; the range check is written
  // with comparisons that are false for undefined, so it reaches Intl formatting with an invalid Date
  // and throws a plain RangeError ("Invalid time value") instead of the 400 ApiError. The lead-time
  // check then 500s instead of answering with a validation message. Fix: require both HH and mm.
  it('BUG FARE-04: rejects a departureTime with no minutes ("09") with a 400 ApiError', async () => {
    const err = await errorOf(() => getDepartureDateTime('2026-01-15', '09'));
    expect(err.code).toBe(400);
    expect(err.message).toBe('Invalid departureDate or departureTime');
  });

  it('BUG FARE-04: rejects an empty departureTime with a 400 ApiError', async () => {
    const err = await errorOf(() => getDepartureDateTime('2026-01-15', ''));
    expect(err.code).toBe(400);
  });
});

describe('getHoursUntilDeparture', () => {
  it('returns fractional hours until the departure instant', () => {
    freezeTime('2026-01-15T04:30:00Z');
    const departure = new Date('2026-01-15T07:30:00Z');
    expect(getHoursUntilDeparture(departure)).toBe(3);
  });

  it('returns 0.5 for 30 minutes remaining', () => {
    freezeTime('2026-01-15T07:00:00Z');
    expect(getHoursUntilDeparture(new Date('2026-01-15T07:30:00Z'))).toBe(0.5);
  });

  it('returns a negative value for a departure in the past', () => {
    freezeTime('2026-01-15T08:30:00Z');
    expect(getHoursUntilDeparture(new Date('2026-01-15T07:00:00Z'))).toBe(-1.5);
  });
});

describe('getMinBookingLeadHours', () => {
  it('returns the 3h split default when no setting exists', async () => {
    useSettings({});
    expect(await getMinBookingLeadHours('split')).toBe(DEFAULT_SPLIT_MIN_BOOKING_HOURS);
  });

  it('returns the configured split lead time', async () => {
    useSettings({ splitRideMinBookingHours: 6 });
    expect(await getMinBookingLeadHours('split')).toBe(6);
    expect(Setting.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('migrates the legacy 24h split setting to 3h and persists the change', async () => {
    useSettings({ splitRideMinBookingHours: 24 });
    expect(await getMinBookingLeadHours('split')).toBe(3);
    expect(Setting.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'splitRideMinBookingHours' },
      { $set: { value: 3 } },
      { upsert: true },
    );
  });

  it('returns the 1h private default when no setting exists', async () => {
    useSettings({});
    expect(await getMinBookingLeadHours('private')).toBe(DEFAULT_PRIVATE_MIN_BOOKING_HOURS);
  });

  it('returns the configured private lead time', async () => {
    useSettings({ privateRideMinBookingHours: 2 });
    expect(await getMinBookingLeadHours('private')).toBe(2);
  });

  it('treats any non-"split" ride type as private', async () => {
    useSettings({ privateRideMinBookingHours: 4, splitRideMinBookingHours: 6 });
    expect(await getMinBookingLeadHours('unknown')).toBe(4);
  });

  it('falls back to the default when the stored value is not a number', async () => {
    useSettings({ privateRideMinBookingHours: 'soon' });
    expect(await getMinBookingLeadHours('private')).toBe(1);
  });

  it('CHARACTERIZATION: a stored value of 0 is treated as missing and falls back to the default', async () => {
    // Surprising: an admin cannot configure "no lead time" through the settings table.
    useSettings({ privateRideMinBookingHours: 0 });
    expect(await getMinBookingLeadHours('private')).toBe(1);
  });
});

describe('getSplitMinDistanceKm', () => {
  it('returns 0 km when no setting exists', async () => {
    useSettings({});
    expect(await getSplitMinDistanceKm()).toBe(DEFAULT_SPLIT_MIN_DISTANCE_KM);
  });

  it('returns a configured distance', async () => {
    useSettings({ splitRideMinDistanceKm: 15 });
    expect(await getSplitMinDistanceKm()).toBe(15);
  });

  it('returns 0 for a negative stored distance', async () => {
    useSettings({ splitRideMinDistanceKm: -4 });
    expect(await getSplitMinDistanceKm()).toBe(0);
  });

  it('returns 0 for a non-numeric stored distance', async () => {
    useSettings({ splitRideMinDistanceKm: 'far' });
    expect(await getSplitMinDistanceKm()).toBe(0);
  });

  it('migrates the legacy 20 km value to 0 and persists it', async () => {
    useSettings({ splitRideMinDistanceKm: 20 });
    expect(await getSplitMinDistanceKm()).toBe(0);
    expect(Setting.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'splitRideMinDistanceKm' },
      { $set: { value: 0 } },
      { upsert: true },
    );
  });

  it('does not migrate 19.99 km (only the exact legacy value is migrated)', async () => {
    useSettings({ splitRideMinDistanceKm: 19.99 });
    expect(await getSplitMinDistanceKm()).toBe(19.99);
    expect(Setting.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('assertSplitMinimumDistance', () => {
  it('passes and returns the minimum when distance equals the minimum (boundary)', async () => {
    useSettings({ splitRideMinDistanceKm: 5 });
    expect(await assertSplitMinimumDistance(5)).toBe(5);
  });

  it('throws 400 with the exact message when distance is just below the minimum', async () => {
    useSettings({ splitRideMinDistanceKm: 5 });
    const err = await errorOf(() => assertSplitMinimumDistance(4.99));
    expect(err.code).toBe(400);
    expect(err.message).toBe('Split ride requires a minimum route distance of 5 km.');
  });

  it('passes any distance when the minimum is 0', async () => {
    useSettings({});
    expect(await assertSplitMinimumDistance(0)).toBe(0);
  });

  it('treats NaN or undefined distance as 0 km, which fails a positive minimum', async () => {
    useSettings({ splitRideMinDistanceKm: 2 });
    await expect(errorOf(() => assertSplitMinimumDistance(NaN))).resolves.toMatchObject({ code: 400 });
    await expect(
      errorOf(() => assertSplitMinimumDistance(undefined as unknown as number)),
    ).resolves.toMatchObject({ code: 400 });
  });

  it('rejects a negative distance when the minimum is 0', async () => {
    useSettings({});
    await expect(errorOf(() => assertSplitMinimumDistance(-1))).resolves.toMatchObject({ code: 400 });
  });
});

describe('getMatchingLastNotifyHours', () => {
  it('defaults to 1 hour', async () => {
    useSettings({});
    expect(await getMatchingLastNotifyHours()).toBe(1);
  });

  it('returns a configured fractional value', async () => {
    useSettings({ matchingLastNotifyHours: 2.5 });
    expect(await getMatchingLastNotifyHours()).toBe(2.5);
  });

  it('falls back to 1 for a zero or negative value', async () => {
    useSettings({ matchingLastNotifyHours: -1 });
    expect(await getMatchingLastNotifyHours()).toBe(1);
  });
});

describe('getRefundRestrictionHours', () => {
  it('defaults to 24h for split and 1h for private', async () => {
    useSettings({});
    expect(await getRefundRestrictionHours('split')).toBe(DEFAULT_SPLIT_REFUND_RESTRICTION_HOURS);
    expect(await getRefundRestrictionHours('private')).toBe(DEFAULT_PRIVATE_REFUND_RESTRICTION_HOURS);
  });

  it('reads the split and private setting keys independently', async () => {
    useSettings({ splitRideRefundRestrictionHours: 48, privateRideRefundRestrictionHours: 2 });
    expect(await getRefundRestrictionHours('split')).toBe(48);
    expect(await getRefundRestrictionHours('private')).toBe(2);
  });

  it('falls back to the default when the configured value is 0', async () => {
    useSettings({ privateRideRefundRestrictionHours: 0 });
    expect(await getRefundRestrictionHours('private')).toBe(1);
  });
});

describe('assertMinimumBookingLeadTime', () => {
  // Now = 04:30Z (06:30 Nicosia). A 09:30 Nicosia departure is 07:30Z, i.e. exactly 3 hours away.
  beforeEach(() => {
    freezeTime('2026-01-15T04:30:00Z');
  });

  it('returns the departure instant, hours and minimum when lead time is exactly the minimum', async () => {
    useSettings({ splitRideMinBookingHours: 3 });
    const result = await assertMinimumBookingLeadTime('2026-01-15', '09:30', 'split');
    expect(result.departureDateTime.toISOString()).toBe('2026-01-15T07:30:00.000Z');
    expect(result.hoursUntilDeparture).toBe(3);
    expect(result.minLeadHours).toBe(3);
  });

  it('throws 400 with the plural split message when less than the minimum remains', async () => {
    freezeTime('2026-01-15T04:31:00Z'); // 2h59m left
    useSettings({ splitRideMinBookingHours: 3 });
    const err = await errorOf(() => assertMinimumBookingLeadTime('2026-01-15', '09:30', 'split'));
    expect(err.code).toBe(400);
    expect(err.message).toBe('Split ride must be scheduled at least 3 hours before pickup time.');
  });

  it('uses the singular "hour" wording for a 1-hour private minimum', async () => {
    freezeTime('2026-01-15T07:00:00Z'); // 30 minutes left
    useSettings({});
    const err = await errorOf(() => assertMinimumBookingLeadTime('2026-01-15', '09:30', 'private'));
    expect(err.message).toBe('Private ride must be scheduled at least 1 hour before pickup time.');
  });

  it('uses the plural "hours" wording for a private minimum greater than 1', async () => {
    freezeTime('2026-01-15T06:30:00Z'); // 1 hour left, minimum 2
    useSettings({ privateRideMinBookingHours: 2 });
    const err = await errorOf(() => assertMinimumBookingLeadTime('2026-01-15', '09:30', 'private'));
    expect(err.message).toBe('Private ride must be scheduled at least 2 hours before pickup time.');
  });

  it('rejects a departure already in the past', async () => {
    freezeTime('2026-01-15T10:00:00Z');
    useSettings({});
    await expect(
      errorOf(() => assertMinimumBookingLeadTime('2026-01-15', '09:30', 'private')),
    ).resolves.toMatchObject({ code: 400 });
  });

  it('propagates the invalid-input error for a malformed departure time', async () => {
    useSettings({});
    const err = await errorOf(() => assertMinimumBookingLeadTime('2026-01-15', '25:00', 'private'));
    expect(err.message).toBe('Invalid departureDate or departureTime');
  });
});
