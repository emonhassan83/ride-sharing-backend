/**
 * `driver:drop-off-passenger` requires a real pickup.
 *
 * Regression: drop-off accepted `in_progress` riders. `in_progress` only means
 * the driver is on the way (driver:start-trip), so start-trip → drop-off →
 * complete finished and charged a trip without the start OTP (checked only in
 * driver:pickup-ride) ever being verified.
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
vi.mock('@src/app/utils/notifyUser.utils', () => ({ notifyUserPush: vi.fn(async () => undefined) }));
vi.mock('@src/app/utils/maps.utils', () => ({
  getRealDistanceAndETA: vi.fn(async () => ({ distanceKm: 5, durationMinutes: 10 })),
}));
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));

import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { Ride } from '@src/app/modules/ride/ride.model';
import { driverDropOffPassengerHandler } from '@src/app/socket/handlers/ride/driverDropOffPassenger.handler';
import { getIO } from '@src/app/socket/socket.init';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, createMockSocket } from '@tests/helpers/socket';

const rideId = oidStr();
const driverId = oidStr();
const passengerId = oidStr();

const passengerDoc = (status: string) => ({
  _id: passengerId,
  rideId,
  userId: oidStr(),
  status,
  estimatedFare: 20,
  pickup: { coordinates: [33.3, 35.1] },
  destination: { coordinates: [33.4, 35.2] },
});

/** Passenger.findOne honours the `status` filter (string or $in) like Mongo would. */
const wirePassenger = (doc: Record<string, any>) => {
  const matches = (filter: any) => {
    const s = filter?.status;
    if (s === undefined) return true;
    if (typeof s === 'string') return s === doc.status;
    return (s.$in || []).includes(doc.status);
  };
  vi.mocked(Passenger.findOne).mockImplementation(((f: any) =>
    mockQuery(matches(f) ? doc : null)) as any);
  vi.mocked(Passenger.findOneAndUpdate).mockImplementation(((f: any, u: any) => {
    if (!matches(f)) return mockQuery(null);
    Object.assign(doc, u.$set);
    return mockQuery(doc);
  }) as any);
};

const run = async (type: 'private' | 'split') => {
  vi.mocked(Ride.findById).mockReturnValue(
    mockQuery({ _id: rideId, driverId, status: 'started', type }) as any,
  );
  const ack = vi.fn();
  const socket = createMockSocket({ userId: driverId, role: 'provider' });
  await (driverDropOffPassengerHandler as any).call(socket, { rideId, passengerId }, ack);
  return ack.mock.calls[0]?.[0];
};

beforeEach(() => {
  vi.mocked(getIO).mockReturnValue(createMockIo() as any);
});

describe('driver:drop-off-passenger needs a pickup (start OTP)', () => {
  for (const type of ['private', 'split'] as const) {
    it(`${type}: an in_progress (driver on the way) rider is refused with PICKUP_REQUIRED`, async () => {
      const doc = passengerDoc('in_progress');
      wirePassenger(doc);

      const res = await run(type);

      expect(res).toMatchObject({ success: false, code: 'PICKUP_REQUIRED', requiresOtp: true });
      expect(doc.status).toBe('in_progress');
    });

    it(`${type}: a picked_up rider is dropped off`, async () => {
      const doc = passengerDoc('picked_up');
      wirePassenger(doc);

      const res = await run(type);

      expect(res).toMatchObject({ success: true });
      expect(doc.status).toBe('dropped_off');
    });
  }
});
