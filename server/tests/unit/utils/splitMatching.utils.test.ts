/**
 * Unit tests: splitMatching.utils (split-ride matching eligibility, time window, seat and
 * rider caps, join/accept gates).
 *
 * Rules under test (see module header): symmetric +-30 min window, inclusive boundaries;
 * Phase 1 = pickups within radius (default 10 km); Phase 2 = destinations within radius.
 * Models (Setting, Passenger, Booking) are mocked; splitFare.utils is mocked for the rider cap
 * (its real module pulls in Stripe/Notifications). Redis is the global fake.
 *
 * Reference geometry: 0.089 deg latitude = 9.896 km; 0.0908 deg = 10.098 km.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { freezeTime } from '@tests/helpers/time';
import { mockQuery, oid } from '@tests/helpers/mongoose';
import { Setting } from '@src/app/modules/settings/settings.model';
import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { Booking } from '@src/app/modules/booking/booking.model';
import { getSplitMaxMatchedRiders } from '@src/app/utils/splitFare.utils';
import { PASSENGER_STATUS } from '@src/app/modules/passenger/passenger.constant';
import { PAYMENT_STATUS as BOOKING_PAYMENT_STATUS } from '@src/app/modules/booking/booking.constant';
import {
  DEFAULT_SPLIT_DESTINATION_MATCH_RADIUS_KM,
  DEFAULT_SPLIT_MATCHING_TIME_WINDOW_MINUTES,
  DEFAULT_SPLIT_PICKUP_MATCH_RADIUS_KM,
  SPLIT_DRIVER_ACCEPTED_STATUSES,
  acquireSplitJoinLock,
  assertDriverCanAcceptSplitPassenger,
  coordsToLatLng,
  countActiveSplitPassengersOnRide,
  enforceSplitMaxRidersAfterJoin,
  findEligibleExistingSplitRide,
  getActiveSplitPassengersOnRide,
  getCandidateDepartureDates,
  getSplitDestinationMatchRadiusKm,
  getSplitMatchingTimeWindowMinutes,
  getSplitPickupMatchRadiusKm,
  getUsedSeatsOnRide,
  isEligibleSplitPair,
  isRequestEligibleForSplitRide,
  passengerToMatchCandidate,
  passesPhase1And2,
  passesTimeWindow,
  releaseSplitJoinLock,
  requestToMatchCandidate,
  withinKm,
  type LatLng,
  type SplitMatchCandidate,
} from '@src/app/utils/splitMatching.utils';

vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
});
vi.mock('@src/app/modules/passenger/passenger.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Passenger: createModelMock() };
});
vi.mock('@src/app/modules/booking/booking.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Booking: createModelMock() };
});
vi.mock('@src/app/utils/splitFare.utils', () => ({ getSplitMaxMatchedRiders: vi.fn() }));

const PICKUP: LatLng = { lat: 35.1856, lng: 33.3823 };
const DEST: LatLng = { lat: 35.0, lng: 33.1 };
const LOOSE_PASSENGER = {
  pickup: { coordinates: [PICKUP.lng, PICKUP.lat] },
  destination: { coordinates: [DEST.lng, DEST.lat] },
  departureDate: '2026-06-01',
  departureTime: '14:00',
};

const candidate = (over: Partial<SplitMatchCandidate> = {}): SplitMatchCandidate => ({
  pickup: PICKUP,
  destination: DEST,
  departureDate: '2026-06-01',
  departureTime: '14:00',
  ...over,
});

/** Setting.findOne({ key }).lean() answers per key; missing keys resolve to null (defaults). */
const setSettings = (values: Record<string, unknown>) =>
  vi.mocked(Setting.findOne).mockImplementation(((filter: { key: string }) =>
    mockQuery(filter.key in values ? { key: filter.key, value: values[filter.key] } : null)) as any);

describe('getCandidateDepartureDates (date pre-fetch around midnight)', () => {
  it('returns only the requested date mid-day', () => {
    expect(getCandidateDepartureDates('2026-03-20', '12:00', 30)).toEqual(['2026-03-20']);
  });

  it('adds the previous day when the window reaches back past midnight (00:10 with 30 min)', () => {
    expect(getCandidateDepartureDates('2026-03-20', '00:10', 30)).toEqual(['2026-03-20', '2026-03-19']);
  });

  it('boundary: 01:30 (90 min) with a 30 min window does NOT add the previous day', () => {
    expect(getCandidateDepartureDates('2026-03-20', '01:30', 30)).toEqual(['2026-03-20']);
  });

  it('boundary: 01:29 (89 min) adds the previous day', () => {
    expect(getCandidateDepartureDates('2026-03-20', '01:29', 30)).toEqual(['2026-03-20', '2026-03-19']);
  });

  it('adds the next day when the window reaches past midnight (23:50 with 30 min)', () => {
    expect(getCandidateDepartureDates('2026-03-20', '23:50', 30)).toEqual(['2026-03-20', '2026-03-21']);
  });

  it('boundary: 22:30 (1350 min) with a 30 min window does NOT add the next day', () => {
    expect(getCandidateDepartureDates('2026-03-20', '22:30', 30)).toEqual(['2026-03-20']);
  });

  it('boundary: 22:31 adds the next day', () => {
    expect(getCandidateDepartureDates('2026-03-20', '22:31', 30)).toEqual(['2026-03-20', '2026-03-21']);
  });

  it('uses a 60 minute margin on top of the window (window 0: 00:59 adds previous day, 01:00 does not)', () => {
    expect(getCandidateDepartureDates('2026-03-20', '00:59', 0)).toEqual(['2026-03-20', '2026-03-19']);
    expect(getCandidateDepartureDates('2026-03-20', '01:00', 0)).toEqual(['2026-03-20']);
  });

  it('a negative window is clamped to 0 (margin stays 60)', () => {
    expect(getCandidateDepartureDates('2026-03-20', '00:59', -30)).toEqual(['2026-03-20', '2026-03-19']);
  });

  it('rolls the previous day across a month boundary (2026-03-01 -> 2026-02-28)', () => {
    expect(getCandidateDepartureDates('2026-03-01', '00:05', 30)).toEqual(['2026-03-01', '2026-02-28']);
  });

  it('rolls the next day across a year boundary (2026-12-31 -> 2027-01-01)', () => {
    expect(getCandidateDepartureDates('2026-12-31', '23:55', 30)).toEqual(['2026-12-31', '2027-01-01']);
  });

  it('handles leap day as the previous day (2028-03-01 -> 2028-02-29)', () => {
    expect(getCandidateDepartureDates('2028-03-01', '00:00', 30)).toEqual(['2028-03-01', '2028-02-29']);
  });

  it('returns only the date when the time is not parseable (NaN)', () => {
    expect(getCandidateDepartureDates('2026-03-20', 'invalid', 30)).toEqual(['2026-03-20']);
  });
});

describe('coordsToLatLng', () => {
  it('maps GeoJSON [lng, lat] to { lat, lng }', () => {
    expect(coordsToLatLng([33.3823, 35.1856])).toEqual({ lat: 35.1856, lng: 33.3823 });
  });

  it('returns null for missing, null or short coordinate arrays (boundary: 1 element)', () => {
    expect(coordsToLatLng(undefined)).toBeNull();
    expect(coordsToLatLng(null)).toBeNull();
    expect(coordsToLatLng([])).toBeNull();
    expect(coordsToLatLng([33.3])).toBeNull();
  });

  it('ignores extra elements beyond the first two', () => {
    expect(coordsToLatLng([1, 2, 3])).toEqual({ lat: 2, lng: 1 });
  });
});

describe('withinKm (inclusive radius, 1e-9 tolerance)', () => {
  // 10 km north of the origin on the meridian (R = 6371 km)
  const tenKmNorth: LatLng = { lat: (10 / 6371) * (180 / Math.PI), lng: 0 };
  const origin: LatLng = { lat: 0, lng: 0 };

  it('is true for the exact radius (boundary)', () => {
    expect(withinKm(origin, tenKmNorth, 10)).toBe(true);
  });

  it('is false when the radius is 10 metres short', () => {
    expect(withinKm(origin, tenKmNorth, 9.99)).toBe(false);
  });

  it('is true when the radius is 10 metres wide', () => {
    expect(withinKm(origin, tenKmNorth, 10.01)).toBe(true);
  });

  it('radius 0 matches only an identical point', () => {
    expect(withinKm(origin, origin, 0)).toBe(true);
    expect(withinKm(origin, { lat: 0.0001, lng: 0 }, 0)).toBe(false);
  });
});

describe('passesTimeWindow (+-30 min, inclusive)', () => {
  it('matches identical departure times', () => {
    expect(passesTimeWindow(candidate(), candidate(), 30)).toBe(true);
  });

  it('14:00 matches 13:30 and 14:30 (exact window edges)', () => {
    expect(passesTimeWindow(candidate({ departureTime: '13:30' }), candidate(), 30)).toBe(true);
    expect(passesTimeWindow(candidate({ departureTime: '14:30' }), candidate(), 30)).toBe(true);
  });

  it('14:00 does not match 13:29 or 14:31', () => {
    expect(passesTimeWindow(candidate({ departureTime: '13:29' }), candidate(), 30)).toBe(false);
    expect(passesTimeWindow(candidate({ departureTime: '14:31' }), candidate(), 30)).toBe(false);
  });

  it('matches across midnight (23:50 vs 00:10 next day = 20 min apart)', () => {
    const late = candidate({ departureDate: '2026-06-01', departureTime: '23:50' });
    const early = candidate({ departureDate: '2026-06-02', departureTime: '00:10' });

    expect(passesTimeWindow(late, early, 30)).toBe(true);
  });

  it('a window of 0 requires the exact same minute', () => {
    expect(passesTimeWindow(candidate(), candidate({ departureTime: '14:01' }), 0)).toBe(false);
    expect(passesTimeWindow(candidate(), candidate(), 0)).toBe(true);
  });

  it('treats an undefined or negative window as 0', () => {
    expect(passesTimeWindow(candidate(), candidate({ departureTime: '14:01' }), undefined as unknown as number)).toBe(false);
    expect(passesTimeWindow(candidate(), candidate({ departureTime: '14:01' }), -30)).toBe(false);
  });

  it('returns false (no throw) when a departure time is invalid', () => {
    expect(passesTimeWindow(candidate({ departureTime: 'nope' }), candidate(), 30)).toBe(false);
  });

  it('returns false (no throw) when a departure date is missing', () => {
    expect(passesTimeWindow(candidate({ departureDate: '' }), candidate(), 30)).toBe(false);
  });
});

describe('passesPhase1And2 (pickup radius, then destination radius)', () => {
  const near = (lat: number): LatLng => ({ lat: PICKUP.lat + lat, lng: PICKUP.lng });

  it('passes when pickups and destinations are both inside their radii', () => {
    expect(passesPhase1And2(candidate(), candidate(), 10, 10)).toBe(true);
  });

  it('fails when the pickups are 10.1 km apart with a 10 km pickup radius (boundary +)', () => {
    const b = candidate({ pickup: near(0.0908) });
    expect(passesPhase1And2(candidate(), b, 10, 10)).toBe(false);
  });

  it('passes when the pickups are 9.9 km apart with a 10 km pickup radius (boundary -)', () => {
    const b = candidate({ pickup: near(0.089) });
    expect(passesPhase1And2(candidate(), b, 10, 10)).toBe(true);
  });

  it('fails on destination distance even when pickups match (Phase 2 uses its own radius)', () => {
    const b = candidate({ destination: { lat: DEST.lat + 0.0908, lng: DEST.lng } });
    expect(passesPhase1And2(candidate(), b, 10, 10)).toBe(false);
    expect(passesPhase1And2(candidate(), b, 10, 11)).toBe(true);
  });
});

describe('isEligibleSplitPair', () => {
  it('requires both the time window and both radii', () => {
    expect(isEligibleSplitPair(candidate(), candidate(), 10, 10, 30)).toBe(true);
    expect(isEligibleSplitPair(candidate({ departureTime: '16:00' }), candidate(), 10, 10, 30)).toBe(false);
    expect(
      isEligibleSplitPair(candidate({ destination: { lat: 0, lng: 0 } }), candidate(), 10, 10, 30),
    ).toBe(false);
  });
});

describe('passengerToMatchCandidate', () => {
  it('builds a candidate from a passenger document with GeoJSON coordinates', () => {
    expect(passengerToMatchCandidate(LOOSE_PASSENGER)).toEqual({
      pickup: PICKUP,
      destination: DEST,
      departureDate: '2026-06-01',
      departureTime: '14:00',
    });
  });

  it.each([
    ['pickup', { pickup: undefined }],
    ['destination', { destination: { coordinates: [1] } }],
    ['departureDate', { departureDate: undefined }],
    ['departureTime', { departureTime: '' }],
  ])('returns null when %s is missing', (_field, patch) => {
    expect(passengerToMatchCandidate({ ...LOOSE_PASSENGER, ...patch })).toBeNull();
  });

  it('returns null for a null passenger', () => {
    expect(passengerToMatchCandidate(null)).toBeNull();
  });
});

describe('requestToMatchCandidate', () => {
  it('copies the request fields into a match candidate', () => {
    const c = candidate({ departureTime: '09:15' });
    expect(requestToMatchCandidate(c)).toEqual(c);
  });
});

describe('split matching settings getters', () => {
  beforeEach(() => {
    setSettings({});
  });

  it('falls back to 10 km pickup and destination radii when no setting exists', async () => {
    expect(await getSplitPickupMatchRadiusKm()).toBe(DEFAULT_SPLIT_PICKUP_MATCH_RADIUS_KM);
    expect(await getSplitDestinationMatchRadiusKm()).toBe(DEFAULT_SPLIT_DESTINATION_MATCH_RADIUS_KM);
    expect(DEFAULT_SPLIT_PICKUP_MATCH_RADIUS_KM).toBe(10);
  });

  it('reads the pickup radius from the splitRidePickupMatchRadiusKm key (string value is coerced)', async () => {
    setSettings({ splitRidePickupMatchRadiusKm: '5' });

    expect(await getSplitPickupMatchRadiusKm()).toBe(5);
    expect(Setting.findOne).toHaveBeenCalledWith({ key: 'splitRidePickupMatchRadiusKm' });
  });

  it('reads the destination radius from its own key', async () => {
    setSettings({ splitRideDestinationMatchRadiusKm: 7.5 });

    expect(await getSplitDestinationMatchRadiusKm()).toBe(7.5);
  });

  it('accepts a radius of exactly 0 (boundary, >= 0)', async () => {
    setSettings({ splitRidePickupMatchRadiusKm: 0 });

    expect(await getSplitPickupMatchRadiusKm()).toBe(0);
  });

  it('falls back to the default for a negative, non-numeric or null radius', async () => {
    setSettings({ splitRidePickupMatchRadiusKm: -1 });
    expect(await getSplitPickupMatchRadiusKm()).toBe(10);

    setSettings({ splitRidePickupMatchRadiusKm: 'far' });
    expect(await getSplitPickupMatchRadiusKm()).toBe(10);

    setSettings({ splitRidePickupMatchRadiusKm: null });
    expect(await getSplitPickupMatchRadiusKm()).toBe(10);
  });

  it('CHARACTERIZATION: an empty-string radius setting is read as 0 km (not the default)', async () => {
    setSettings({ splitRidePickupMatchRadiusKm: '' });

    expect(await getSplitPickupMatchRadiusKm()).toBe(0);
  });

  it('time window defaults to 30 minutes', async () => {
    expect(await getSplitMatchingTimeWindowMinutes()).toBe(DEFAULT_SPLIT_MATCHING_TIME_WINDOW_MINUTES);
    expect(DEFAULT_SPLIT_MATCHING_TIME_WINDOW_MINUTES).toBe(30);
  });

  it('time window honours a custom positive value', async () => {
    setSettings({ splitRideMatchingTimeWindowMinutes: 45 });

    expect(await getSplitMatchingTimeWindowMinutes()).toBe(45);
  });

  it('legacy stored 0 (old "exact time" default) falls back to 30 minutes', async () => {
    setSettings({ splitRideMatchingTimeWindowMinutes: 0 });

    expect(await getSplitMatchingTimeWindowMinutes()).toBe(30);
  });

  it('a negative time window falls back to 30 minutes', async () => {
    setSettings({ splitRideMatchingTimeWindowMinutes: -5 });

    expect(await getSplitMatchingTimeWindowMinutes()).toBe(30);
  });
});

describe('passenger queries on a ride', () => {
  const EXCLUDED = [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected, PASSENGER_STATUS.split_matching];

  it('getActiveSplitPassengersOnRide excludes cancelled, rejected and split_matching, oldest first', async () => {
    const rows = [{ _id: oid(), requestedSeats: 2 }];
    vi.mocked(Passenger.find).mockReturnValue(mockQuery(rows) as any);

    expect(await getActiveSplitPassengersOnRide('ride-1')).toEqual(rows);
    expect(Passenger.find).toHaveBeenCalledWith({ rideId: 'ride-1', status: { $nin: EXCLUDED } });
  });

  it('countActiveSplitPassengersOnRide counts with the same filter', async () => {
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(2) as any);

    expect(await countActiveSplitPassengersOnRide('ride-1')).toBe(2);
    expect(Passenger.countDocuments).toHaveBeenCalledWith({ rideId: 'ride-1', status: { $nin: EXCLUDED } });
  });

  it('getUsedSeatsOnRide sums requestedSeats; a missing or zero value counts as 1 seat', async () => {
    vi.mocked(Passenger.find).mockReturnValue(
      mockQuery([{ requestedSeats: 2 }, { requestedSeats: undefined }, { requestedSeats: 0 }]) as any,
    );

    expect(await getUsedSeatsOnRide('ride-1')).toBe(4);
  });

  it('getUsedSeatsOnRide is 0 for a ride with no active passengers', async () => {
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([]) as any);

    expect(await getUsedSeatsOnRide('ride-1')).toBe(0);
  });

  it('SPLIT_DRIVER_ACCEPTED_STATUSES lists the seats the driver has accepted (not pending)', () => {
    expect(SPLIT_DRIVER_ACCEPTED_STATUSES).toContain(PASSENGER_STATUS.confirmed);
    expect(SPLIT_DRIVER_ACCEPTED_STATUSES).toContain(PASSENGER_STATUS.completed);
    expect(SPLIT_DRIVER_ACCEPTED_STATUSES).not.toContain(PASSENGER_STATUS.pending);
  });
});

describe('split join lock (Redis SET NX EX)', () => {
  beforeEach(() => {
    freezeTime('2026-06-01T10:00:00Z');
  });

  it('acquires the lock once and refuses a second concurrent join', async () => {
    expect(await acquireSplitJoinLock('ride-1')).toBe(true);
    expect(await acquireSplitJoinLock('ride-1')).toBe(false);
  });

  it('stores the lock with a 15 second TTL by default', async () => {
    await acquireSplitJoinLock('ride-1');

    expect(fakeRedis.peek('split:join:lock:ride-1')).toBe('1');
    expect(await fakeRedis.ttl('split:join:lock:ride-1')).toBe(15);
  });

  it('honours a custom TTL', async () => {
    await acquireSplitJoinLock('ride-1', 30);

    expect(await fakeRedis.ttl('split:join:lock:ride-1')).toBe(30);
  });

  it('is re-acquirable after release', async () => {
    await acquireSplitJoinLock('ride-1');
    await releaseSplitJoinLock('ride-1');

    expect(await acquireSplitJoinLock('ride-1')).toBe(true);
  });

  it('expires automatically after the TTL (boundary: still held at 14 s, free at 15 s)', async () => {
    await acquireSplitJoinLock('ride-1');

    vi.setSystemTime(new Date('2026-06-01T10:00:14Z'));
    expect(await acquireSplitJoinLock('ride-1')).toBe(false);

    vi.setSystemTime(new Date('2026-06-01T10:00:15Z'));
    expect(await acquireSplitJoinLock('ride-1')).toBe(true);
  });

  it('locks are per ride', async () => {
    await acquireSplitJoinLock('ride-1');

    expect(await acquireSplitJoinLock('ride-2')).toBe(true);
  });
});

describe('enforceSplitMaxRidersAfterJoin (max = 3)', () => {
  beforeEach(() => {
    vi.mocked(getSplitMaxMatchedRiders).mockResolvedValue(3);
  });

  it('keeps the passenger when the ride has exactly the max (boundary N)', async () => {
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(3) as any);

    expect(await enforceSplitMaxRidersAfterJoin('ride-1', 'p-3')).toEqual({
      ok: true,
      maxMatchedRiders: 3,
      activeCount: 3,
    });
    expect(Passenger.deleteOne).not.toHaveBeenCalled();
    expect(Passenger.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('cancel_new (default): removes the overflow passenger and its bookings (N+1)', async () => {
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(4) as any);

    const result = await enforceSplitMaxRidersAfterJoin('ride-1', 'p-4');

    expect(result).toEqual({ ok: false, maxMatchedRiders: 3, activeCount: 4 });
    expect(Booking.deleteMany).toHaveBeenCalledWith({ passengerId: 'p-4', rideId: 'ride-1' });
    expect(Passenger.deleteOne).toHaveBeenCalledWith({ _id: 'p-4', rideId: 'ride-1' });
    expect(Passenger.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('detach_to_matching: returns the passenger to the matching pool and unlinks the booking', async () => {
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(4) as any);

    const result = await enforceSplitMaxRidersAfterJoin('ride-1', 'p-4', 'detach_to_matching');

    expect(result.ok).toBe(false);
    expect(Passenger.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'p-4', rideId: 'ride-1' },
      {
        rideId: null,
        status: PASSENGER_STATUS.split_matching,
        matchedVia: undefined,
        matchedAt: undefined,
      },
    );
    expect(Booking.findOneAndUpdate).toHaveBeenCalledWith(
      { passengerId: 'p-4', rideId: 'ride-1' },
      { rideId: null, driverId: null },
    );
    expect(Passenger.deleteOne).not.toHaveBeenCalled();
    expect(Booking.deleteMany).not.toHaveBeenCalled();
  });

  it('a ride with zero riders is always ok', async () => {
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(0) as any);

    expect((await enforceSplitMaxRidersAfterJoin('ride-1', 'p-1')).ok).toBe(true);
  });

  it('uses a configured max rider count', async () => {
    vi.mocked(getSplitMaxMatchedRiders).mockResolvedValue(2);
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(3) as any);

    expect(await enforceSplitMaxRidersAfterJoin('ride-1', 'p-3')).toEqual({
      ok: false,
      maxMatchedRiders: 2,
      activeCount: 3,
    });
  });
});

describe('assertDriverCanAcceptSplitPassenger (max = 3)', () => {
  const [a, b, c, d] = [oid(), oid(), oid(), oid()];
  const actives = (...ids: unknown[]) => ids.map((_id) => ({ _id }));

  beforeEach(() => {
    vi.mocked(getSplitMaxMatchedRiders).mockResolvedValue(3);
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(0) as any);
    vi.mocked(Passenger.find).mockReturnValue(mockQuery(actives(a, b, c, d)) as any);
  });

  it('refuses when the number of accepted seats has already reached the max', async () => {
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(3) as any);

    expect(await assertDriverCanAcceptSplitPassenger('ride-1', a)).toEqual({
      ok: false,
      message: 'Split ride allows a maximum of 3 matched riders. Driver cannot accept more.',
    });
  });

  it('counts only driver-accepted statuses when checking the cap', async () => {
    await assertDriverCanAcceptSplitPassenger('ride-1', a);

    expect(Passenger.countDocuments).toHaveBeenCalledWith({
      rideId: 'ride-1',
      status: { $in: [...SPLIT_DRIVER_ACCEPTED_STATUSES] },
    });
  });

  it('accepts the earliest passenger when two seats are free (2 accepted, first in line)', async () => {
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(2) as any);

    expect(await assertDriverCanAcceptSplitPassenger('ride-1', a)).toEqual({ ok: true });
  });

  it('accepts the third-in-line passenger (boundary: slot 3 of 3)', async () => {
    expect(await assertDriverCanAcceptSplitPassenger('ride-1', c)).toEqual({ ok: true });
  });

  it('refuses the fourth-in-line passenger (N+1) with the outside-the-cap message', async () => {
    expect(await assertDriverCanAcceptSplitPassenger('ride-1', d)).toEqual({
      ok: false,
      message:
        'Split ride allows a maximum of 3 matched riders. This passenger is outside the cap.',
    });
  });

  it('matches the passenger id by string value (ObjectId vs string)', async () => {
    expect(await assertDriverCanAcceptSplitPassenger('ride-1', String(b))).toEqual({ ok: true });
  });

  it('refuses a passenger that is not on the ride at all', async () => {
    const result = await assertDriverCanAcceptSplitPassenger('ride-1', 'stranger');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('outside the cap');
  });
});

describe('isRequestEligibleForSplitRide', () => {
  const RIDE_ID = oid();
  const rideFor = (over: Record<string, unknown> = {}) => ({
    _id: RIDE_ID,
    totalSeats: 4,
    pickup: { coordinates: [PICKUP.lng, PICKUP.lat] },
    destination: { coordinates: [DEST.lng, DEST.lat] },
    departureDate: '2026-06-01',
    departureTime: '14:00',
    ...over,
  });
  const passengerOn = (over: Record<string, unknown> = {}) => ({
    _id: oid(),
    requestedSeats: 1,
    ...LOOSE_PASSENGER,
    ...over,
  });

  beforeEach(() => {
    vi.mocked(getSplitMaxMatchedRiders).mockResolvedValue(3);
    setSettings({});
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([]) as any);
    vi.mocked(Booking.exists).mockReturnValue(mockQuery({ _id: oid() }) as any);
  });

  it('refuses a ride whose fare is locked, without querying passengers (fare_locked short-circuit)', async () => {
    const result = await isRequestEligibleForSplitRide(candidate(), rideFor({ splitFareLocked: true }));

    expect(result).toEqual({ ok: false, reason: 'fare_locked', activePassengers: [], usedSeats: 0 });
    expect(Passenger.find).not.toHaveBeenCalled();
  });

  it('refuses when the ride already has the max number of riders (3 = N, boundary)', async () => {
    const riders = [passengerOn(), passengerOn(), passengerOn()];
    vi.mocked(Passenger.find).mockReturnValue(mockQuery(riders) as any);

    const result = await isRequestEligibleForSplitRide(candidate(), rideFor());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('max_riders');
    expect(result.activePassengers).toEqual(riders);
  });

  it('allows a 2nd rider when the ride has 2 riders (N-1)', async () => {
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([passengerOn(), passengerOn()]) as any);

    expect((await isRequestEligibleForSplitRide(candidate(), rideFor())).ok).toBe(true);
  });

  it('fills the last seat exactly (3 used + 1 requested = 4 of 4)', async () => {
    vi.mocked(Passenger.find).mockReturnValue(
      mockQuery([passengerOn({ requestedSeats: 2 }), passengerOn({ requestedSeats: 1 })]) as any,
    );

    const result = await isRequestEligibleForSplitRide(candidate(), rideFor(), { requestedSeats: 1 });

    expect(result).toMatchObject({ ok: true, usedSeats: 3 });
  });

  it('refuses when the requested seats would exceed the vehicle (3 used + 2 requested > 4)', async () => {
    vi.mocked(Passenger.find).mockReturnValue(
      mockQuery([passengerOn({ requestedSeats: 2 }), passengerOn({ requestedSeats: 1 })]) as any,
    );

    const result = await isRequestEligibleForSplitRide(candidate(), rideFor(), { requestedSeats: 2 });

    expect(result).toMatchObject({ ok: false, reason: 'no_seats', usedSeats: 3 });
  });

  it('skips the seat check when the ride has no totalSeats', async () => {
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([passengerOn({ requestedSeats: 9 })]) as any);

    expect((await isRequestEligibleForSplitRide(candidate(), rideFor({ totalSeats: 0 }), { requestedSeats: 9 })).ok).toBe(true);
  });

  it('requires a paid or authorized booking on the ride by default', async () => {
    vi.mocked(Booking.exists).mockReturnValue(mockQuery(null) as any);

    const result = await isRequestEligibleForSplitRide(candidate(), rideFor());

    expect(result).toMatchObject({ ok: false, reason: 'no_paid_booking' });
    expect(Booking.exists).toHaveBeenCalledWith({
      rideId: RIDE_ID,
      paymentStatus: { $in: [BOOKING_PAYMENT_STATUS.authorized, BOOKING_PAYMENT_STATUS.paid] },
    });
  });

  it('skips the paid-booking check when requirePaidBooking is false', async () => {
    vi.mocked(Booking.exists).mockReturnValue(mockQuery(null) as any);

    expect((await isRequestEligibleForSplitRide(candidate(), rideFor(), { requirePaidBooking: false })).ok).toBe(true);
    expect(Booking.exists).not.toHaveBeenCalled();
  });

  it('with no riders yet, compares the request against the ride pickup and destination', async () => {
    expect((await isRequestEligibleForSplitRide(candidate(), rideFor())).ok).toBe(true);

    const far = await isRequestEligibleForSplitRide(
      candidate({ pickup: { lat: PICKUP.lat + 0.0908, lng: PICKUP.lng } }),
      rideFor(),
    );
    expect(far).toMatchObject({ ok: false, reason: 'geo_or_time' });
  });

  it('with no riders and no ride geo, refuses with missing_ride_geo', async () => {
    const result = await isRequestEligibleForSplitRide(candidate(), rideFor({ pickup: undefined }));

    expect(result).toMatchObject({ ok: false, reason: 'missing_ride_geo' });
  });

  it('a rider without usable coordinates is not an anchor, so the ride geo is used instead', async () => {
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([{ _id: oid(), requestedSeats: 1 }]) as any);

    expect((await isRequestEligibleForSplitRide(candidate(), rideFor())).ok).toBe(true);
  });

  it('every existing rider must match, not just one (second rider too far -> geo_or_time)', async () => {
    vi.mocked(Passenger.find).mockReturnValue(
      mockQuery([
        passengerOn(),
        passengerOn({ pickup: { coordinates: [PICKUP.lng, PICKUP.lat + 0.0908] } }),
      ]) as any,
    );

    expect(await isRequestEligibleForSplitRide(candidate(), rideFor())).toMatchObject({
      ok: false,
      reason: 'geo_or_time',
    });
  });

  it('time boundary: a request 30 min after the rider is eligible, 31 min is not', async () => {
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([passengerOn()]) as any);

    expect((await isRequestEligibleForSplitRide(candidate({ departureTime: '14:30' }), rideFor())).ok).toBe(true);
    expect((await isRequestEligibleForSplitRide(candidate({ departureTime: '14:31' }), rideFor())).ok).toBe(false);
  });

  it('honours configured radii and window from settings (window 60 admits 15:00 vs 14:00)', async () => {
    setSettings({ splitRideMatchingTimeWindowMinutes: 60 });
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([passengerOn()]) as any);

    expect((await isRequestEligibleForSplitRide(candidate({ departureTime: '15:00' }), rideFor())).ok).toBe(true);
  });
});

describe('findEligibleExistingSplitRide', () => {
  const rideA = { _id: oid(), totalSeats: 4, pickup: { coordinates: [PICKUP.lng, PICKUP.lat] }, destination: { coordinates: [DEST.lng, DEST.lat] }, departureDate: '2026-06-01', departureTime: '14:00' };
  const rideB = { ...rideA, _id: oid() };
  const riderOn = (_ride: unknown) => ({ _id: oid(), requestedSeats: 1, ...LOOSE_PASSENGER });

  beforeEach(() => {
    vi.mocked(getSplitMaxMatchedRiders).mockResolvedValue(3);
    setSettings({});
    vi.mocked(Booking.exists).mockReturnValue(mockQuery({ _id: oid() }) as any);
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([]) as any);
    vi.mocked(Passenger.findOne).mockReturnValue(mockQuery(null) as any);
  });

  it('returns null when there are no candidate rides', async () => {
    expect(await findEligibleExistingSplitRide(candidate(), [])).toBeNull();
  });

  it('returns the first eligible ride with its used seats and riders', async () => {
    const result = await findEligibleExistingSplitRide(candidate(), [rideA, rideB]);

    expect(result).toEqual({ ride: rideA, usedSeats: 0, activePassengers: [] });
  });

  it('skips a ride that is not eligible and returns the next one', async () => {
    vi.mocked(Passenger.find).mockImplementation(((filter: { rideId: unknown }) =>
      mockQuery(filter.rideId === rideA._id ? [riderOn(rideA), riderOn(rideA), riderOn(rideA)] : [])) as any);

    const result = await findEligibleExistingSplitRide(candidate(), [rideA, rideB]);

    expect(result?.ride).toBe(rideB);
  });

  it('returns null when no ride is eligible', async () => {
    vi.mocked(Booking.exists).mockReturnValue(mockQuery(null) as any);

    expect(await findEligibleExistingSplitRide(candidate(), [rideA, rideB])).toBeNull();
  });

  it('skips a ride the user has already joined (userId given)', async () => {
    const userId = 'user-1';
    vi.mocked(Passenger.findOne).mockImplementation(((filter: { rideId: unknown }) =>
      mockQuery(filter.rideId === rideA._id ? { _id: oid() } : null)) as any);

    const result = await findEligibleExistingSplitRide(candidate(), [rideA, rideB], { userId });

    expect(result?.ride).toBe(rideB);
    expect(Passenger.findOne).toHaveBeenCalledWith({
      rideId: rideA._id,
      userId,
      status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
    });
  });

  it('does not check existing membership when no userId is given', async () => {
    await findEligibleExistingSplitRide(candidate(), [rideA]);

    expect(Passenger.findOne).not.toHaveBeenCalled();
  });
});

describe('acquire/release helpers do not leak into other rides', () => {
  it('releaseSplitJoinLock removes only the given ride lock', async () => {
    await acquireSplitJoinLock('ride-1');
    await acquireSplitJoinLock('ride-2');
    await releaseSplitJoinLock('ride-1');

    expect(fakeRedis.peek('split:join:lock:ride-1')).toBeNull();
    expect(fakeRedis.peek('split:join:lock:ride-2')).toBe('1');
  });
});
