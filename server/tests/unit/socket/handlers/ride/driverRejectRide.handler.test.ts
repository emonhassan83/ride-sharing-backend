/**
 * Unit tests: `driver:reject-ride` socket handler.
 *
 * Pattern reference for socket-handler tests (see tests/README.md):
 *  - handler = `eventHandler(fn)`; invoke with `handler.call(socket, data, ack)`
 *  - `getIO()` is mocked to return a recording fake `io` (who was told what)
 *  - Redis is the global in-memory fake (assert on real keys / TTLs)
 *  - the DB models are fakes configured per test
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/app/modules/ride/ride.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Ride: createModelMock() };
});
vi.mock('@src/app/modules/passenger/passenger.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Passenger: createModelMock() };
});
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
});
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));
vi.mock('@src/app/utils/splitFare.utils', () => ({
  recalculateSplitFares: vi.fn(async () => undefined),
}));

import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { Ride } from '@src/app/modules/ride/ride.model';
import { driverRejectRideHandler } from '@src/app/socket/handlers/ride/driverRejectRide.handler';
import { getIO } from '@src/app/socket/socket.init';
import { recalculateSplitFares } from '@src/app/utils/splitFare.utils';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockDoc, mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, createMockSocket, type MockIo } from '@tests/helpers/socket';
import { freezeTime } from '@tests/helpers/time';

const NOW = '2026-03-20T00:00:00Z';
const rideId = oidStr();
const passengerId = oidStr();
const riderUserId = oidStr();
const driverId = oidStr();

let io: MockIo;
let ack: ReturnType<typeof vi.fn>;
let driverSocket: ReturnType<typeof createMockSocket>;

const makeRide = (overrides: Record<string, unknown> = {}) =>
  mockDoc({
    _id: rideId,
    type: 'private',
    status: 'pending',
    departureDate: '2026-03-20',
    departureTime: '12:00', // 12:00 Nicosia (UTC+2) = 10:00Z -> 10h after NOW
    ...overrides,
  });

const makePassenger = (overrides: Record<string, unknown> = {}) =>
  mockDoc({
    _id: passengerId,
    userId: riderUserId,
    rideId,
    status: 'pending',
    ...overrides,
  });

const arrange = (ride: unknown, passenger: unknown = null) => {
  vi.mocked(Ride.findById).mockReturnValue(mockQuery(ride) as any);
  vi.mocked(Passenger.findOne).mockReturnValue(mockQuery(passenger) as any);
};

const run = (data: Record<string, unknown>, socket = driverSocket) =>
  driverRejectRideHandler.call(socket as any, data, ack as any);

beforeEach(() => {
  freezeTime(NOW);
  io = createMockIo();
  vi.mocked(getIO).mockReturnValue(io as any);
  ack = vi.fn();
  driverSocket = createMockSocket({ userId: driverId, role: 'provider' });
});

describe('driver:reject-ride - input & ride state guards', () => {
  it('requires a rideId', async () => {
    await run({});
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'Missing required fields' });
    expect(Ride.findById).not.toHaveBeenCalled();
  });

  it('requires an authenticated socket user', async () => {
    const anonymous = createMockSocket();
    anonymous.auth = undefined;
    await run({ rideId }, anonymous);
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'Missing required fields' });
    expect(Ride.findById).not.toHaveBeenCalled();
  });

  it('rejects an unknown ride', async () => {
    arrange(null);
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: 'Ride already accepted or cancelled',
    });
  });

  it.each(['accepted', 'started', 'completed', 'cancelled'])(
    'refuses to reject a ride that is already %s',
    async (status) => {
      arrange(makeRide({ status }));
      await run({ rideId });
      expect(ack).toHaveBeenCalledWith({
        success: false,
        message: 'Ride already accepted or cancelled',
      });
      expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(io.emitted).toHaveLength(0);
    },
  );

  it('answers "Unknown ride type" for a ride that is neither private nor split', async () => {
    arrange(makeRide({ type: 'mystery' }));
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'Unknown ride type' });
  });
});

describe('driver:reject-ride - PRIVATE ride', () => {
  it('records the rejection: notifies the rider, blacklists the driver, frees the ride for fallback matching', async () => {
    arrange(makeRide(), makePassenger());

    await run({ rideId });

    // rider is told the driver declined and that we keep searching
    expect(io.payloadTo(`user:${riderUserId}`, 'ride:driver-rejected')).toEqual({
      rideId,
      passengerId,
      reason: 'Driver is busy',
      searchingAgain: true,
      rideCancelled: false,
    });

    // the driver can never be offered this ride again
    expect(await fakeRedis.smembers(`ride:rejected:${rideId}`)).toEqual([driverId]);

    // the ride is released from this driver but stays pending
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(rideId, {
      $pull: { notifiedDriverIds: driverId },
      $unset: { driverId: '', vehicleId: '' },
    });
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledTimes(1); // never cancelled

    // matching bookkeeping for the fallback job
    const req = await fakeRedis.hgetall(`ride:request:${rideId}`);
    expect(req).toMatchObject({
      matchingStatus: 'driver_rejected_waiting_for_fallback',
      lastRejectedDriverId: driverId,
    });
    expect(Number(req.lastRejectedAt)).toBe(new Date(NOW).getTime());

    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Private ride rejection recorded. Ride remains pending for fallback matching.',
      data: { passengerCount: 1, rideCancelled: false },
    });
  });

  it('relays a custom rejection reason to the rider', async () => {
    arrange(makeRide(), makePassenger());
    await run({ rideId, reason: 'Car broke down' });
    expect(io.payloadTo(`user:${riderUserId}`, 'ride:driver-rejected').reason).toBe('Car broke down');
  });

  it('looks up the passenger by id when one is supplied, else the pending passenger of the ride', async () => {
    arrange(makeRide(), makePassenger());
    await run({ rideId, passengerId });
    expect(Passenger.findOne).toHaveBeenLastCalledWith({ _id: passengerId, rideId });

    await run({ rideId });
    expect(Passenger.findOne).toHaveBeenLastCalledWith({ rideId, status: 'pending' });
  });

  it('does nothing (no emit, no redis, no db write) when the passenger cannot be found', async () => {
    arrange(makeRide(), null);
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: 'Passenger not found or already processed',
    });
    expect(io.emitted).toHaveLength(0);
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(await fakeRedis.exists(`ride:rejected:${rideId}`)).toBe(0);
  });

  describe('rejected-list TTL = time until departure + 2h, never below 30 minutes', () => {
    it('departure in 10h -> 12h TTL', async () => {
      arrange(makeRide(), makePassenger());
      await run({ rideId });
      expect(await fakeRedis.ttl(`ride:rejected:${rideId}`)).toBe(10 * 3600 + 7200);
    });

    it('departure already in the past -> floor of 1800s', async () => {
      arrange(makeRide({ departureDate: '2026-03-19', departureTime: '10:00' }), makePassenger());
      await run({ rideId });
      expect(await fakeRedis.ttl(`ride:rejected:${rideId}`)).toBe(1800);
    });

    it('departure 1 minute ago -> still 2h minus 1 minute (above the floor)', async () => {
      freezeTime('2026-03-20T10:01:00Z'); // 1 minute after the 12:00 EET departure
      arrange(makeRide(), makePassenger());
      await run({ rideId });
      expect(await fakeRedis.ttl(`ride:rejected:${rideId}`)).toBe(7200 - 60);
    });
  });

  it('turns a corrupt departure time into a failed ack plus a socketError event (no crash)', async () => {
    arrange(makeRide({ departureTime: 'garbage' }), makePassenger());
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'Invalid departureDate or departureTime' }),
    );
    expect(driverSocket.emit).toHaveBeenCalledWith(
      'socketError',
      expect.objectContaining({ success: false, status: 400 }),
    );
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('surfaces unexpected database failures through the standard error channel', async () => {
    arrange(makeRide(), makePassenger());
    vi.mocked(Ride.findByIdAndUpdate).mockImplementation(() => {
      throw new Error('db down');
    });
    await run({ rideId });
    // B-22: internal error text (e.g. Mongo messages) is logged, not shown to users.
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong!' }));
    expect(driverSocket.emit).toHaveBeenCalledWith(
      'socketError',
      expect.objectContaining({ status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong!' }),
    );
  });
});

describe('driver:reject-ride - SPLIT ride', () => {
  const splitRide = () => makeRide({ type: 'split' });

  it('requires a passengerId (a driver rejects one rider at a time)', async () => {
    arrange(splitRide());
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: 'passengerId is required for split ride',
    });
  });

  it('reports an unknown passenger', async () => {
    arrange(splitRide(), null);
    await run({ rideId, passengerId });
    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: 'Passenger not found or already processed',
    });
  });

  it('rejects the passenger, recalculates the remaining riders\' fares and keeps the ride alive', async () => {
    const passenger = makePassenger();
    arrange(splitRide(), passenger);
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(2) as any);

    await run({ rideId, passengerId, reason: 'Too far' });

    expect(passenger.status).toBe('rejected');
    expect(passenger.rejectionReason).toBe('Too far');
    expect(passenger.save).toHaveBeenCalledTimes(1);
    expect(io.payloadTo(`user:${riderUserId}`, 'ride:driver-rejected')).toMatchObject({
      reason: 'Too far',
      searchingAgain: true,
      rideCancelled: false,
    });
    expect(await fakeRedis.smembers(`ride:rejected:${rideId}`)).toEqual([driverId]);
    expect(recalculateSplitFares).toHaveBeenCalledWith(rideId, 'passenger_rejected', io);
    expect(Passenger.countDocuments).toHaveBeenCalledWith({ rideId, status: 'pending' });
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled(); // 2 riders still waiting
    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Passenger rejected successfully',
      data: { passengerId, remainingPassengers: 2, rideCancelled: false },
    });
  });

  it('uses default reasons when none is given', async () => {
    const passenger = makePassenger();
    arrange(splitRide(), passenger);
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(1) as any);
    await run({ rideId, passengerId });
    expect(passenger.rejectionReason).toBe('Driver rejected');
    expect(io.payloadTo(`user:${riderUserId}`, 'ride:driver-rejected').reason).toBe(
      'Driver rejected your request',
    );
  });

  it('cancels the ride and cleans the matching queue when the LAST waiting passenger is rejected', async () => {
    arrange(splitRide(), makePassenger());
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(0) as any);
    await fakeRedis.zadd('ride:matching:queue', 1, rideId);
    await fakeRedis.hset(`ride:request:${rideId}`, { matchingStatus: 'x' });

    await run({ rideId, passengerId });

    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(rideId, {
      status: 'cancelled',
      cancellationReason: 'No passengers left after driver rejection',
      cancelledBy: 'system',
      cancelledAt: new Date(NOW),
    });
    expect(await fakeRedis.zscore('ride:matching:queue', rideId)).toBeNull();
    expect(await fakeRedis.exists(`ride:request:${rideId}`)).toBe(0);
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: { passengerId, remainingPassengers: 0, rideCancelled: true },
      }),
    );
  });

  it('does not touch the ride when it was NOT the last passenger (queue entry survives)', async () => {
    arrange(splitRide(), makePassenger());
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(1) as any);
    await fakeRedis.zadd('ride:matching:queue', 1, rideId);

    await run({ rideId, passengerId });

    expect(await fakeRedis.zscore('ride:matching:queue', rideId)).toBe('1');
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});

describe('FIXED BUGS (regression tests)', () => {
  // BUG-REPORT SOCK-1 | medium | driverRejectRide.handler.ts:17-30
  // The handler never checks the caller's role (nor that the ride was offered to / assigned to
  // the caller). Any authenticated socket - including a rider - can emit `driver:reject-ride`,
  // which unsets the ride's driver, blacklists "the driver" and (split) rejects a passenger.
  // `it.fails` keeps CI green while the bug is open and turns red once it is fixed, so the
  // marker must then be removed.
  it('BUG SOCK-1: a rider (non-driver) socket must not be able to reject a ride', async () => {
    const rider = createMockSocket({ userId: oidStr(), role: 'user' });
    arrange(makeRide(), makePassenger());

    await run({ rideId }, rider);

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(await fakeRedis.exists(`ride:rejected:${rideId}`)).toBe(0);
  });
});
