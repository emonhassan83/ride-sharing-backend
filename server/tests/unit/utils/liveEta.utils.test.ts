/**
 * Issue 13: "Driver arrived, but the app still says 'Driver Arriving in 1 min'".
 *
 * Before: every location ping sent ONE ride-level `ride:live-update` to every rider,
 * including riders whose driver had already arrived, with an ETA measured to the
 * ride DESTINATION (on a started ride) and floored at 1 minute.
 * Now: each rider gets their own phase + ETA, and ETA 0 once the driver has arrived.
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
vi.mock('@src/app/utils/maps.utils', () => ({ getRealDistanceAndETA: vi.fn() }));

import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { Ride } from '@src/app/modules/ride/ride.model';
import { driverLocationUpdateHandler } from '@src/app/socket/handlers/ride/driverLocationUpdate.handler';
import { getIO } from '@src/app/socket/socket.init';
import { buildRiderLiveUpdates, passengerLivePhase, pickLeadUpdate } from '@src/app/utils/liveEta.utils';
import { getRealDistanceAndETA } from '@src/app/utils/maps.utils';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockDoc, mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, createMockSocket } from '@tests/helpers/socket';

const DRIVER = { lat: 35.17, lng: 33.36 };
const pax = (status: string, pickup: number[], destination: number[]) => ({
  _id: oidStr(),
  userId: oidStr(),
  status,
  pickup: { coordinates: pickup },
  destination: { coordinates: destination },
});

describe('passengerLivePhase', () => {
  it.each([
    ['confirmed', 'to_pickup'],
    ['in_progress', 'to_pickup'],
    ['driver_arrived', 'arrived'],
    ['picked_up', 'to_destination'],
  ])('%s -> %s', (status, phase) => {
    expect(passengerLivePhase(status)).toBe(phase);
  });
});

describe('buildRiderLiveUpdates', () => {
  const etaFn = vi.fn(async (_from: any, to: any) => ({ distanceKm: to.lat, durationMinutes: Math.round(to.lng) }));

  it('ISSUE 13: driver has arrived for this rider -> eta 0, distance 0, phase "arrived" (was "1 min")', async () => {
    const [u] = await buildRiderLiveUpdates(DRIVER, [pax('driver_arrived', [33.4, 35.2], [33.0, 34.7])], etaFn);
    expect(u).toMatchObject({ phase: 'arrived', eta: 0, distance: 0 });
    expect(etaFn).not.toHaveBeenCalled();
  });

  it("heading to the pickup measures to THIS rider's pickup (was: the ride destination)", async () => {
    const [u] = await buildRiderLiveUpdates(DRIVER, [pax('in_progress', [33.4, 35.2], [33.0, 34.7])], etaFn);
    expect(u.phase).toBe('to_pickup');
    expect(etaFn).toHaveBeenCalledWith(DRIVER, { lat: 35.2, lng: 33.4 });
  });

  it("on board, measures to THIS rider's drop-off", async () => {
    const [u] = await buildRiderLiveUpdates(DRIVER, [pax('picked_up', [33.4, 35.2], [33.0, 34.7])], etaFn);
    expect(u.phase).toBe('to_destination');
    expect(etaFn).toHaveBeenCalledWith(DRIVER, { lat: 34.7, lng: 33.0 });
  });

  it('split ride: each rider gets their own value; one Maps call per distinct target', async () => {
    const a = pax('in_progress', [33.4, 35.2], [33.0, 34.7]);
    const b = pax('in_progress', [33.4, 35.2], [33.0, 34.7]); // same pickup
    const c = pax('driver_arrived', [33.5, 35.3], [33.0, 34.7]);
    const updates = await buildRiderLiveUpdates(DRIVER, [a, b, c], etaFn);

    expect(updates.map((u) => u.phase)).toEqual(['to_pickup', 'to_pickup', 'arrived']);
    expect(etaFn).toHaveBeenCalledTimes(1);
    expect(pickLeadUpdate(updates)?.phase).toBe('to_pickup');
  });
});

describe('ISSUE 13: what the rider actually receives on each driver location ping', () => {
  const driverId = oidStr();
  const rideId = oidStr();
  let io: any;

  beforeEach(async () => {
    io = createMockIo();
    vi.mocked(getIO).mockReturnValue(io);
    await fakeRedis.sadd('users:online', driverId);
    vi.mocked(Ride.findOne).mockReturnValue(
      mockQuery(mockDoc({ _id: rideId, status: 'started', type: 'private' })) as any,
    );
    vi.mocked(getRealDistanceAndETA).mockResolvedValue({ distanceKm: 3, durationMinutes: 1 } as any);
  });

  it('after arrival the rider gets eta 0 / phase "arrived", and no second ride-level ETA', async () => {
    const rider = pax('driver_arrived', [33.4, 35.2], [33.0, 34.7]);
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([rider]) as any);

    await (driverLocationUpdateHandler as any).call(
      createMockSocket({ userId: driverId, role: 'provider' }),
      { lat: 35.2, lng: 33.4 },
      vi.fn(),
    );

    const toRider = io.emittedTo(`user:${rider.userId}`, 'ride:live-update');
    expect(toRider).toHaveLength(1);
    expect(toRider[0].payload[0]).toMatchObject({ phase: 'arrived', eta: 0, distance: 0, passengerId: rider._id });
    // The ride-room broadcast excludes riders' own rooms (see the handler's .except()).
    const roomEmit = io.emittedTo(`ride:${rideId}`, 'ride:live-update');
    expect(roomEmit).toHaveLength(1);
    expect(roomEmit[0].rooms).not.toContain(`user:${rider.userId}`);
  });

  it('before arrival the rider gets their pickup ETA', async () => {
    const rider = pax('in_progress', [33.4, 35.2], [33.0, 34.7]);
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([rider]) as any);
    vi.mocked(getRealDistanceAndETA).mockResolvedValue({ distanceKm: 4.2, durationMinutes: 9 } as any);

    await (driverLocationUpdateHandler as any).call(
      createMockSocket({ userId: driverId, role: 'provider' }),
      { lat: 35.17, lng: 33.36 },
      vi.fn(),
    );

    expect(io.payloadTo(`user:${rider.userId}`, 'ride:live-update')).toMatchObject({
      phase: 'to_pickup',
      eta: 9,
      distance: 4.2,
    });
    expect(getRealDistanceAndETA).toHaveBeenCalledWith({ lat: 35.17, lng: 33.36 }, { lat: 35.2, lng: 33.4 });
  });
});
