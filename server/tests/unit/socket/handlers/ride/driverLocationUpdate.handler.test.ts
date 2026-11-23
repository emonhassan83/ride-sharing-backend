/**
 * Issue 58 follow-up: "offline but still got requests".
 *
 * Before: every `driver:location-update` re-added the driver to `users:online` and the GEO
 * index, so a driver who pressed "go offline" but whose app kept sending location was
 * immediately dispatchable again. Now location pings only refresh availability for
 * drivers who are online.
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
vi.mock('@src/app/modules/passenger/passenger.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Passenger: createModelMock() };
});
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));
vi.mock('@src/app/socket/utils/triggerArrival', () => ({ triggerArrival: vi.fn() }));

import { User } from '@src/app/modules/user/user.model';
import {
  driverLocationUpdateHandler,
  isDriverMarkedOnline,
} from '@src/app/socket/handlers/ride/driverLocationUpdate.handler';
import { getIO } from '@src/app/socket/socket.init';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, createMockSocket } from '@tests/helpers/socket';

const driverId = oidStr();

const ping = async () => {
  const socket = createMockSocket({ userId: driverId, role: 'provider' });
  const ack = vi.fn();
  await (driverLocationUpdateHandler as any).call(socket, { lat: 35.18, lng: 33.38 }, ack);
  return ack.mock.calls[0]?.[0];
};

beforeEach(() => {
  vi.mocked(getIO).mockReturnValue(createMockIo() as any);
});

describe('ISSUE 58: location pings from an OFFLINE driver', () => {
  beforeEach(() => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ _id: driverId, isOnline: false }) as any);
  });

  it('do not put the driver back into users:online or the dispatch GEO index', async () => {
    const ack = await ping();

    expect(await fakeRedis.sismember('users:online', driverId)).toBe(0);
    expect(await fakeRedis.zscore('drivers:location', driverId)).toBeNull();
    expect(await fakeRedis.get(`driver:${driverId}:current`)).toBeNull();
    expect(ack).toMatchObject({ success: true, hasRide: false, isOnline: false });
  });

  it('ask the DB at most once per 30 s while the app keeps pinging', async () => {
    await ping();
    await ping();
    await ping();

    expect(User.findById).toHaveBeenCalledTimes(1);
  });
});

describe('location pings from an ONLINE driver', () => {
  it('refresh availability as before (no DB read when already in users:online)', async () => {
    await fakeRedis.sadd('users:online', driverId);

    const ack = await ping();

    expect(User.findById).not.toHaveBeenCalled();
    expect(await fakeRedis.zscore('drivers:location', driverId)).not.toBeNull();
    expect(await fakeRedis.get(`driver:${driverId}:current`)).not.toBeNull();
    expect(ack).toMatchObject({ success: true, isOnline: true });
  });

  it('a DB-online driver missing from the set (e.g. after a Redis restart) is restored', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ _id: driverId, isOnline: true }) as any);

    expect(await isDriverMarkedOnline(fakeRedis, driverId)).toBe(true);
    await ping();
    expect(await fakeRedis.sismember('users:online', driverId)).toBe(1);
  });
});
