/**
 * Issues 61 / 63 / 42: who actually receives a new ride request.
 *
 * Scenario: pickup in Nicosia. Drivers:
 *   - moving:  pinged 1 minute ago, 2 km away              -> notified (before and after)
 *   - parked:  app open + online, last ping 3 h ago, 1 km  -> notified (was SKIPPED before: issues 61/63)
 *   - ghost:   last ping 3 h ago, app closed, 1 km         -> not notified (issue 42: no "28 drivers")
 *   - far:     pinged 1 minute ago, 25 km away             -> not notified
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/ride/ride.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Ride: createModelMock() };
});
vi.mock('@src/app/modules/vehicle/vehicle.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Vehicle: createModelMock() };
});
vi.mock('@src/app/utils/notifyUser.utils', () => ({ notifyUserPush: vi.fn() }));
vi.mock('@src/app/utils/geo.utils', () => ({ hasDriverRideAtDateTime: vi.fn() }));

import { Ride } from '@src/app/modules/ride/ride.model';
import { User } from '@src/app/modules/user/user.model';
import { Vehicle } from '@src/app/modules/vehicle/vehicle.model';
import { hasDriverRideAtDateTime } from '@src/app/utils/geo.utils';
import {
  notifyNearbyDrivers,
  notifyNearbyDriversForSplitRide,
  notifyRiderDriversNotified,
  runWithConcurrency,
} from '@src/app/utils/notifyDrivers.utils';
import { notifyUserPush } from '@src/app/utils/notifyUser.utils';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, type MockIo } from '@tests/helpers/socket';

const PICKUP = { lat: 35.1856, lng: 33.3823 }; // Nicosia
const KM = 1 / 111; // ~1 km in degrees of latitude
const THREE_HOURS = 3 * 60 * 60 * 1000;

const rideId = oidStr();
const moving = oidStr();
const parked = oidStr();
const ghost = oidStr();
const far = oidStr();

let io: MockIo;

const placeDriver = async (
  id: string,
  kmNorth: number,
  opts: { pingAgoMs: number; current?: boolean; online?: boolean; connected?: boolean },
) => {
  const lat = PICKUP.lat + kmNorth * KM;
  await fakeRedis.geoadd('drivers:location', PICKUP.lng, lat, id);
  await fakeRedis.hset(`driver:${id}:details`, {
    lastLat: String(lat),
    lastLng: String(PICKUP.lng),
    lastUpdate: String(Date.now() - opts.pingAgoMs),
  });
  if (opts.current) {
    await fakeRedis.set(`driver:${id}:current`, JSON.stringify({ lat, lng: PICKUP.lng }));
  }
  if (opts.online) await fakeRedis.sadd('users:online', id);
  if (opts.connected) io.sockets.adapter.rooms.set(`driver:${id}`, new Set([`sock-${id}`]));
};

const payload = (rideType: 'private' | 'split') => ({
  _id: oidStr(),
  rideType,
  departureDate: '2026-11-23',
  departureTime: '14:00',
  requestedSeats: 1,
});

beforeEach(async () => {
  io = createMockIo();
  vi.mocked(User.findById).mockImplementation(
    () =>
      mockQuery({
        _id: 'x',
        isDeleted: false,
        status: 'active',
        isKycVerified: true,
        isOnline: true,
        fcmToken: 'tok',
        language: 'en',
      }) as any,
  );
  vi.mocked(Ride.findOneAndUpdate).mockImplementation(() => mockQuery({ _id: rideId }) as any);
  vi.mocked(Ride.findByIdAndUpdate).mockImplementation(() => mockQuery(null) as any);
  vi.mocked(Vehicle.find).mockReturnValue(mockQuery([]) as any);
  vi.mocked(hasDriverRideAtDateTime).mockResolvedValue({ available: true } as any);

  await placeDriver(moving, 2, { pingAgoMs: 60_000, current: true, online: true, connected: true });
  await placeDriver(parked, 1, { pingAgoMs: THREE_HOURS, online: true, connected: true });
  await placeDriver(ghost, 1, { pingAgoMs: THREE_HOURS }); // app closed long ago, still in GEO set
  await placeDriver(far, 25, { pingAgoMs: 60_000, current: true, online: true, connected: true });
});

const notifiedIds = () =>
  vi.mocked(notifyUserPush).mock.calls.map(([input]) => String((input as any).userId)).sort();

describe('ISSUES 61 / 63: private ride dispatch', () => {
  it('notifies the moving driver AND the parked-but-connected driver; skips the ghost and the far driver', async () => {
    const count = await notifyNearbyDrivers(rideId, PICKUP, payload('private'), fakeRedis, io);

    expect(count).toBe(2);
    expect(notifiedIds()).toEqual([moving, parked].sort());
  });

  it('the parked driver gets the live socket event, not just a push', async () => {
    await notifyNearbyDrivers(rideId, PICKUP, payload('private'), fakeRedis, io);

    expect(io.emittedTo(`driver:${parked}`, 'ride:new-request')).toHaveLength(1);
  });

  it('BEFORE-FIX behaviour (old rule ignored connections): with no socket signal the parked driver is skipped', async () => {
    const ioWithoutConnections = createMockIo(); // no driver rooms => nobody "connected"
    const count = await notifyNearbyDrivers(rideId, PICKUP, payload('private'), fakeRedis, ioWithoutConnections);

    expect(count).toBe(1);
    expect(notifiedIds()).toEqual([moving]);
  });
});

describe('ISSUE 42: the "drivers notified" count only includes drivers who can actually take the ride', () => {
  it('stale accounts that are only in the GEO set are not counted', async () => {
    // 20 old test accounts around the pickup, none pinged in the last 45 min, none connected
    for (let i = 0; i < 20; i++) {
      await placeDriver(oidStr(), 0.5 + i * 0.1, { pingAgoMs: THREE_HOURS });
    }

    const count = await notifyNearbyDrivers(rideId, PICKUP, payload('private'), fakeRedis, io);

    expect(count).toBe(2);
  });
});

describe('ISSUES 58 / 63: split ride dispatch uses the same rule', () => {
  it('reaches the parked-but-connected driver', async () => {
    const count = await notifyNearbyDriversForSplitRide(
      rideId,
      null,
      PICKUP,
      payload('split'),
      fakeRedis,
      io,
    );

    expect(count).toBe(2);
    expect(notifiedIds()).toEqual([moving, parked].sort());
  });
});

describe('ISSUE 9: "Drivers Notified" followed by "Still Searching" with the same count', () => {
  const riderId = oidStr();
  const searchRide = oidStr();
  const tell = (variant: 'matching' | 'rematch', count: number, rematchStage: 'initial' | 'final' = 'initial') => {
    vi.mocked(Ride.findById).mockReturnValue(
      mockQuery({ notifiedDriverIds: Array.from({ length: count }, () => oidStr()) }) as any,
    );
    return notifyRiderDriversNotified({
      io,
      userId: riderId,
      rideId: searchRide,
      passengerId: 'p1',
      newlyNotified: 0,
      variant,
      rematchStage,
    });
  };
  const titles = () => vi.mocked(notifyUserPush).mock.calls.map(([i]) => (i as any).message);

  it('the cron re-match with the SAME driver count sends no second push (socket update only)', async () => {
    await tell('matching', 3);
    await tell('rematch', 3, 'initial');
    await tell('rematch', 3, 'final');

    expect(titles()).toEqual(['Drivers Notified']);
    expect(io.emittedTo(`user:${riderId}`, 'ride:drivers-notified')).toHaveLength(3);
  });

  it('when MORE drivers have been reached, the rider is told again', async () => {
    await tell('matching', 3);
    await tell('rematch', 5);

    expect(titles()).toEqual(['Drivers Notified', 'Still Searching for a Driver']);
  });
});

describe('ISSUE 4: drivers are notified in parallel, not one by one', () => {
  it('runWithConcurrency runs up to N at a time and processes every item', async () => {
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    const started = Date.now();

    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 50));
      seen.push(n);
      running--;
    });

    expect(peak).toBe(5);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(Date.now() - started).toBeLessThan(400); // sequential would be ~500 ms
  });

  it('one failing driver does not stop the others', async () => {
    const done: number[] = [];
    await runWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      done.push(n);
    });
    expect(done.sort()).toEqual([1, 3]);
  });

  it('a slow FCM send for one driver no longer delays the others (12 drivers, 100 ms each)', async () => {
    for (let i = 0; i < 12; i++) {
      await placeDriver(oidStr(), 0.5 + i * 0.05, { pingAgoMs: 60_000, current: true, online: true, connected: true });
    }
    vi.mocked(notifyUserPush).mockImplementation(() => new Promise((r) => setTimeout(r, 100)));
    const started = Date.now();

    const count = await notifyNearbyDrivers(rideId, PICKUP, payload('private'), fakeRedis, io);

    expect(count).toBe(14); // 12 new + moving + parked from the shared setup
    expect(Date.now() - started).toBeLessThan(800); // sequential: >= 1.4 s
  });
});
