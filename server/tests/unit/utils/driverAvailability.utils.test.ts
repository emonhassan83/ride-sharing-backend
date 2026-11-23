/**
 * Issues 61 / 63 / 42: the shared "is this driver available right now" rule.
 *
 * Before: only a GPS ping in the last 45 minutes counted. A driver parked with the
 * app open (connected, online, but not moving, so no pings) was silently dropped
 * from dispatch until they restarted the app.
 */
import { describe, expect, it } from 'vitest';
import {
  FRESH_LOCATION_MS,
  getDriverLiveState,
  isDriverSocketConnected,
  isUsablePoint,
} from '@src/app/utils/driverAvailability.utils';
import { fakeRedis } from '@tests/helpers/fakeRedis';

const NOW = Date.UTC(2026, 10, 23, 10, 0, 0);
const ioWith = (...rooms: string[]) => ({
  sockets: { adapter: { rooms: new Map(rooms.map((r) => [r, new Set(['sock-1'])])) } },
});

const seedHash = (id: string, ageMs: number | null, lat = '35.1', lng = '33.3') =>
  fakeRedis.hset(`driver:${id}:details`, {
    lastLat: lat,
    lastLng: lng,
    ...(ageMs === null ? {} : { lastUpdate: String(NOW - ageMs) }),
  });

describe('getDriverLiveState', () => {
  it('a current-location key (ping in the last 5 min) is live and wins over the hash', async () => {
    await fakeRedis.set('driver:d1:current', JSON.stringify({ lat: 35.2, lng: 33.4 }));
    await seedHash('d1', 60 * 60 * 1000);

    expect(await getDriverLiveState(fakeRedis, 'd1', undefined, NOW)).toEqual({
      live: true,
      location: { lat: 35.2, lng: 33.4 },
    });
  });

  it('a hash ping inside the 45 min window is live', async () => {
    await seedHash('d1', FRESH_LOCATION_MS - 1000);
    expect(await getDriverLiveState(fakeRedis, 'd1', undefined, NOW)).toEqual({
      live: true,
      location: { lat: 35.1, lng: 33.3 },
    });
  });

  it('a hash ping older than 45 min, not connected, is NOT live (old/test accounts, issue 42)', async () => {
    await seedHash('d1', FRESH_LOCATION_MS + 1000);
    expect(await getDriverLiveState(fakeRedis, 'd1', ioWith(), NOW)).toEqual({
      live: false,
      location: null,
    });
  });

  it('ISSUE 63: a parked driver (stale ping) whose app is connected and online IS live', async () => {
    await seedHash('d1', 3 * 60 * 60 * 1000);
    await fakeRedis.sadd('users:online', 'd1');

    expect(await getDriverLiveState(fakeRedis, 'd1', ioWith('driver:d1'), NOW)).toEqual({
      live: true,
      location: { lat: 35.1, lng: 33.3 },
    });
  });

  it('ISSUE 63: a reconnected driver whose restored hash has no lastUpdate is live while connected + online', async () => {
    await seedHash('d1', null);
    await fakeRedis.sadd('users:online', 'd1');

    expect((await getDriverLiveState(fakeRedis, 'd1', ioWith('driver:d1'), NOW)).live).toBe(true);
  });

  it('connected but went offline (not in users:online) is not live', async () => {
    await seedHash('d1', 3 * 60 * 60 * 1000);
    expect((await getDriverLiveState(fakeRedis, 'd1', ioWith('driver:d1'), NOW)).live).toBe(false);
  });

  it('online in Redis but no connected socket and a stale ping is not live', async () => {
    await seedHash('d1', 3 * 60 * 60 * 1000);
    await fakeRedis.sadd('users:online', 'd1');
    expect((await getDriverLiveState(fakeRedis, 'd1', ioWith(), NOW)).live).toBe(false);
  });

  it('a corrupted current-location record falls back to the hash', async () => {
    await fakeRedis.set('driver:d1:current', '{broken');
    await seedHash('d1', 1000);
    expect(await getDriverLiveState(fakeRedis, 'd1', undefined, NOW)).toEqual({
      live: true,
      location: { lat: 35.1, lng: 33.3 },
    });
  });

  it('live without a usable stored point reports location null', async () => {
    await seedHash('d1', 1000, '0', '0');
    expect(await getDriverLiveState(fakeRedis, 'd1', undefined, NOW)).toEqual({
      live: true,
      location: null,
    });
  });

  it('a driver with no Redis data at all is not live', async () => {
    expect(await getDriverLiveState(fakeRedis, 'nobody', ioWith(), NOW)).toEqual({
      live: false,
      location: null,
    });
  });
});

describe('isDriverSocketConnected / isUsablePoint', () => {
  it('reads the local adapter room of the driver', () => {
    expect(isDriverSocketConnected(ioWith('driver:d1'), 'd1')).toBe(true);
    expect(isDriverSocketConnected(ioWith('driver:d2'), 'd1')).toBe(false);
    expect(isDriverSocketConnected(undefined, 'd1')).toBe(false);
    expect(isDriverSocketConnected({ sockets: { adapter: { rooms: new Map([['driver:d1', new Set()]]) } } }, 'd1')).toBe(false);
  });

  it.each([
    [35.1, 33.3, true],
    [0, 0, false],
    [91, 10, false],
    [10, 181, false],
    [Number.NaN, 10, false],
  ])('isUsablePoint(%s, %s) = %s', (lat, lng, expected) => {
    expect(isUsablePoint(lat, lng)).toBe(expected);
  });
});
