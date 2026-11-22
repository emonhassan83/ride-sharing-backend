/**
 * Unit tests: `ride:cancel-before-accept` socket handler (rider cancels while the ride is pending).
 *
 * Models and the payment service are mocked; the handler's own writes (passenger, ride, seats,
 * Redis matching keys, driver/co-rider notifications) are asserted with exact arguments.
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
vi.mock('@src/app/modules/booking/booking.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Booking: createModelMock() };
});
vi.mock('@src/app/modules/payment/payment.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Payment: createModelMock() };
});
vi.mock('@src/app/modules/payment/payment.service', () => ({
  PaymentService: { cancelAuthorizedBookingPayment: vi.fn() },
}));
vi.mock('@src/app/utils/notifyUser.utils', () => ({ notifyUserPush: vi.fn() }));
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));
vi.mock('@src/app/utils/splitFare.utils', () => ({ transferRideOwnership: vi.fn() }));

import { Booking } from '@src/app/modules/booking/booking.model';
import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { Payment } from '@src/app/modules/payment/payment.model';
import { PaymentService } from '@src/app/modules/payment/payment.service';
import { Ride } from '@src/app/modules/ride/ride.model';
import { rideCancelBeforeAcceptHandler } from '@src/app/socket/handlers/ride/rideCancelBeforeAccept.handler';
import { getIO } from '@src/app/socket/socket.init';
import { notifyUserPush } from '@src/app/utils/notifyUser.utils';
import { transferRideOwnership } from '@src/app/utils/splitFare.utils';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockDoc, mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, createMockSocket, type MockIo } from '@tests/helpers/socket';
import { freezeTime } from '@tests/helpers/time';

type Doc = Record<string, any>;

const NOW = '2026-03-20T00:00:00Z';
const rideId = oidStr();
const creatorId = oidStr();
const driverA = oidStr();
const driverB = oidStr();

// ── tiny in-memory fakes (only the filter operators this handler uses) ──
const matchOne = (doc: Doc, filter: Doc): boolean =>
  Object.entries(filter).every(([key, cond]) => {
    const actual = doc[key];
    if (cond !== null && typeof cond === 'object' && !(cond as any)._bsontype) {
      if ('$in' in cond) return (cond as Doc).$in.map(String).includes(String(actual));
      if ('$nin' in cond) return !(cond as Doc).$nin.map(String).includes(String(actual));
      if ('$ne' in cond) return String((cond as Doc).$ne) !== String(actual);
    }
    return String(actual) === String(cond);
  });

const collection = (docs: Doc[]) => ({
  findOne: (filter: Doc = {}) => mockQuery(docs.find((d) => matchOne(d, filter)) ?? null),
  find: (filter: Doc = {}) => mockQuery(docs.filter((d) => matchOne(d, filter))),
});

const byId = (docs: Doc[], id: unknown) => docs.find((d) => String(d._id) === String(id)) ?? null;

const applyUpdate = (doc: Doc | null, update: Doc) => {
  if (!doc) return;
  for (const [k, v] of Object.entries(update)) {
    if (k === '$inc') for (const [f, n] of Object.entries(v as Doc)) doc[f] = (doc[f] ?? 0) + (n as number);
    else if (!k.startsWith('$')) doc[k] = v;
  }
};

interface World {
  ride: Doc;
  passengers: Doc[];
  bookings?: any[];
}

const wire = (w: World) => {
  const passengers = collection(w.passengers);
  vi.mocked(Ride.findById).mockImplementation((() => mockQuery(w.ride)) as any);
  vi.mocked(Ride.findByIdAndUpdate).mockImplementation(((_id: unknown, update: Doc) => {
    applyUpdate(w.ride, update);
    return mockQuery(w.ride);
  }) as any);
  vi.mocked(Passenger.findOne).mockImplementation(passengers.findOne as any);
  vi.mocked(Passenger.find).mockImplementation(passengers.find as any);
  vi.mocked(Passenger.findByIdAndUpdate).mockImplementation(((id: unknown, update: Doc) => {
    applyUpdate(byId(w.passengers, id), update);
    return mockQuery(byId(w.passengers, id));
  }) as any);
  vi.mocked(Booking.findOne).mockImplementation(collection(w.bookings ?? []).findOne as any);
  vi.mocked(Payment.findOne).mockImplementation(collection([]).findOne as any);
};

const makeRide = (o: Doc = {}): Doc => ({
  _id: rideId,
  type: 'private',
  status: 'pending',
  rideCreatedBy: creatorId,
  notifiedDriverIds: [],
  bookedSeats: 2,
  totalSeats: 4,
  ...o,
});

const makePassenger = (o: Doc = {}): Doc => ({
  _id: oidStr(),
  rideId,
  userId: oidStr(),
  status: 'pending',
  requestedSeats: 1,
  ...o,
});

let io: MockIo;
let ack: ReturnType<typeof vi.fn>;

const asUser = (userId: string) => createMockSocket({ userId, role: 'user' });
const run = (data: Doc, socket = asUser(creatorId)) =>
  rideCancelBeforeAcceptHandler.call(socket as any, data, ack as any);

beforeEach(async () => {
  freezeTime(NOW);
  io = createMockIo();
  vi.mocked(getIO).mockReturnValue(io as any);
  vi.mocked(transferRideOwnership).mockResolvedValue(true);
  ack = vi.fn();
  await fakeRedis.hset(`ride:request:${rideId}`, { matchingStatus: 'x' });
  await fakeRedis.zadd('ride:matching:queue', 1, rideId);
});

describe('ride:cancel-before-accept - guards', () => {
  it('requires rideId and an authenticated rider', async () => {
    await run({});
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'Missing required fields' });
    const anonymous = createMockSocket();
    anonymous.auth = undefined;
    await run({ rideId }, anonymous);
    expect(ack).toHaveBeenLastCalledWith({ success: false, message: 'Missing required fields' });
    expect(Ride.findById).not.toHaveBeenCalled();
  });

  it('reports a ride that does not exist', async () => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(null) as any);
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'Ride not found' });
  });

  it.each(['accepted', 'started', 'completed', 'cancelled', 'rejected'])(
    'refuses once the ride is no longer pending (status %s) and writes nothing',
    async (status) => {
      const p = makePassenger({ userId: creatorId });
      wire({ ride: makeRide({ status }), passengers: [p] });
      await run({ rideId });
      expect(ack).toHaveBeenCalledWith({ success: false, message: 'Cannot cancel: driver already accepted' });
      expect(Passenger.findOne).not.toHaveBeenCalled();
      expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(io.emitted).toHaveLength(0);
    },
  );

  it('looks up the caller\'s PENDING passenger on this ride', async () => {
    const p = makePassenger({ userId: creatorId });
    wire({ ride: makeRide(), passengers: [p] });
    await run({ rideId });
    expect(Passenger.findOne).toHaveBeenCalledWith({ rideId, userId: creatorId, status: 'pending' });
  });

  it.each([
    ['not on the ride', 'confirmed'],
    ['already cancelled', 'cancelled'],
    ['rejected by the driver', 'rejected'],
  ])('a passenger who is %s cannot cancel: "No pending booking found"', async (_label, status) => {
    const p = makePassenger({ userId: creatorId, status });
    wire({ ride: makeRide(), passengers: [p] });
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'No pending booking found' });
    expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});

describe('ride:cancel-before-accept - PRIVATE ride', () => {
  it('cancels the rider\'s booking and the ride, clears matching state, notifies the driver(s)', async () => {
    const rider = oidStr();
    const p = makePassenger({ userId: rider });
    const ride = makeRide({ notifiedDriverIds: [driverA, driverB] });
    wire({ ride, passengers: [p] });

    await run({ rideId, reason: 'Changed my mind' }, asUser(rider));

    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(p._id, {
      status: 'cancelled',
      cancellationReason: 'Changed my mind',
      cancelledBy: 'user',
    });
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(rideId, {
      status: 'cancelled',
      cancellationReason: 'Changed my mind',
      cancelledBy: 'user',
      cancelledAt: new Date(NOW),
    });
    expect(ride.status).toBe('cancelled');
    expect(await fakeRedis.zscore('ride:matching:queue', rideId)).toBeNull();
    expect(await fakeRedis.exists(`ride:request:${rideId}`)).toBe(0);

    expect(io.payloadTo(`driver:${driverA}`, 'ride:cancelled-by-rider')).toEqual({
      rideId,
      message: 'Rider cancelled before acceptance.',
      rideCancelled: true,
    });
    expect(io.payloadTo(`driver:${driverB}`, 'ride:cancelled-by-rider')).toEqual({
      rideId,
      message: 'Rider cancelled before acceptance.',
      rideCancelled: true,
    });
    expect(notifyUserPush).toHaveBeenCalledTimes(2);
    expect(notifyUserPush).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: driverA,
        message: 'Ride Cancelled by Rider',
        description: 'Rider cancelled before acceptance.',
        data: { type: 'RIDE_CANCELLED_BY_RIDER', rideId },
      }),
    );
    expect(ack).toHaveBeenCalledWith({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true } });
  });

  it('defaults the reason to "Cancelled by rider" for passenger and ride', async () => {
    const rider = oidStr();
    const p = makePassenger({ userId: rider });
    wire({ ride: makeRide(), passengers: [p] });
    await run({ rideId }, asUser(rider));
    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(
      p._id,
      expect.objectContaining({ cancellationReason: 'Cancelled by rider' }),
    );
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(
      rideId,
      expect.objectContaining({ cancellationReason: 'Cancelled by rider' }),
    );
  });

  it('a driver who was notified twice is told (and pushed) only once', async () => {
    const rider = oidStr();
    wire({ ride: makeRide({ notifiedDriverIds: [driverA, driverA, driverB] }), passengers: [makePassenger({ userId: rider })] });
    await run({ rideId }, asUser(rider));
    expect(notifyUserPush).toHaveBeenCalledTimes(2);
    expect(io.emittedEvents('ride:cancelled-by-rider')).toHaveLength(2);
  });

  it('with no driver ever notified: the rider is still cancelled, no driver is pushed', async () => {
    const rider = oidStr();
    wire({ ride: makeRide({ notifiedDriverIds: [] }), passengers: [makePassenger({ userId: rider })] });
    await run({ rideId }, asUser(rider));
    expect(notifyUserPush).not.toHaveBeenCalled();
    expect(io.emitted).toHaveLength(0);
    expect(ack).toHaveBeenCalledWith({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true } });
  });

  it('idempotent: a repeat cancel of the same ride is refused and sends no second notice', async () => {
    const rider = oidStr();
    wire({ ride: makeRide({ notifiedDriverIds: [driverA] }), passengers: [makePassenger({ userId: rider })] });
    await run({ rideId }, asUser(rider));
    await run({ rideId }, asUser(rider));
    expect(notifyUserPush).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenLastCalledWith({ success: false, message: 'Cannot cancel: driver already accepted' });
  });
});

describe('ride:cancel-before-accept - SPLIT ride', () => {
  const split = (o: Doc = {}) => makeRide({ type: 'split', ...o });

  it('creator leaves and ONE other rider remains: ride cancelled, that rider is cancelled and told', async () => {
    const creator = makePassenger({ userId: creatorId });
    const other = makePassenger({ userId: oidStr() });
    const ride = split({ notifiedDriverIds: [driverA] });
    wire({ ride, passengers: [creator, other] });

    await run({ rideId });

    expect(ride.status).toBe('cancelled');
    expect(ride.cancellationReason).toBe('Creator cancelled, only one passenger remaining. Ride cancelled.');
    expect(transferRideOwnership).not.toHaveBeenCalled();
    expect(other.status).toBe('cancelled');
    expect(other.cancellationReason).toBe('Only one passenger remaining. Ride cancelled.');
    expect(io.payloadTo(`user:${other.userId}`, 'ride:cancelled')).toEqual({
      rideId,
      message: 'Ride was cancelled because not enough passengers remained.',
    });
    expect(io.payloadTo(`driver:${driverA}`, 'ride:cancelled-by-rider').message).toBe(
      'Only one passenger remaining. Ride cancelled.',
    );
    expect(ack).toHaveBeenCalledWith({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true } });
  });

  it('creator leaves and NOBODY else remains: ride cancelled with the creator-specific reason', async () => {
    const creator = makePassenger({ userId: creatorId });
    const ride = split({ notifiedDriverIds: [driverA] });
    wire({ ride, passengers: [creator] });

    await run({ rideId });

    expect(ride.cancellationReason).toBe('Creator cancelled before acceptance');
    expect(io.payloadTo(`driver:${driverA}`, 'ride:cancelled-by-rider').message).toBe('All passengers cancelled.');
    expect(ack).toHaveBeenCalledWith({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true } });
  });

  it('creator leaves with TWO others: ownership is transferred and the ride stays open with seats released', async () => {
    const creator = makePassenger({ userId: creatorId });
    const b = makePassenger({ userId: oidStr() });
    const c = makePassenger({ userId: oidStr() });
    const ride = split({ bookedSeats: 3, totalSeats: 4 });
    wire({ ride, passengers: [creator, b, c] });

    await run({ rideId });

    expect(transferRideOwnership).toHaveBeenCalledWith(rideId, creatorId, io);
    expect(ride.status).toBe('pending');
    expect(ride.bookedSeats).toBe(2); // 3 booked - creator's 1 seat
    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Cancelled successfully.',
      data: { rideCancelled: false, remainingPassengers: 2 },
    });
  });

  it('creator leaves, ownership transfer reports nobody to hand over to: ride cancelled', async () => {
    const creator = makePassenger({ userId: creatorId });
    const b = makePassenger({ userId: oidStr() });
    const c = makePassenger({ userId: oidStr() });
    const ride = split();
    wire({ ride, passengers: [creator, b, c] });
    vi.mocked(transferRideOwnership).mockResolvedValueOnce(false);

    await run({ rideId });

    expect(ride.status).toBe('cancelled');
    expect(ride.cancellationReason).toBe('Creator cancelled before acceptance');
    expect(ack).toHaveBeenCalledWith({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true } });
  });

  it('a non-creator leaves a 3-rider ride: seats released, co-riders and driver told with seats left, ride stays pending', async () => {
    const creator = makePassenger({ userId: creatorId });
    const leaver = makePassenger({ userId: oidStr(), requestedSeats: 1 });
    const other = makePassenger({ userId: oidStr() });
    const ride = split({ bookedSeats: 3, totalSeats: 4, notifiedDriverIds: [driverA] });
    wire({ ride, passengers: [creator, leaver, other] });

    await run({ rideId }, asUser(leaver.userId));

    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(
      rideId,
      { $inc: { bookedSeats: -1 } },
      { returnDocument: 'after' },
    );
    expect(ride.status).toBe('pending');
    expect(leaver.status).toBe('cancelled');
    expect(creator.status).toBe('pending');
    // 4 total - 2 still booked after the leaver's seat is released
    expect(io.payloadTo(`driver:${driverA}`, 'ride:cancelled-by-rider')).toEqual({
      rideId,
      message: 'A passenger cancelled before driver acceptance.',
      rideCancelled: false,
      passengerId: leaver._id,
      remainingSeats: 2,
    });
    for (const co of [creator, other]) {
      expect(io.payloadTo(`user:${co.userId}`, 'ride:co-passenger-cancelled')).toEqual({
        rideId,
        cancelledPassengerId: leaver._id,
        remainingSeats: 2,
        message: 'Another passenger cancelled.',
      });
    }
    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Cancelled successfully.',
      data: { rideCancelled: false, remainingPassengers: 2 },
    });
  });

  it('a non-creator leaves a 2-rider ride: the last rider is cancelled and the ride is cancelled', async () => {
    const creator = makePassenger({ userId: creatorId });
    const leaver = makePassenger({ userId: oidStr() });
    const ride = split({ notifiedDriverIds: [driverA] });
    wire({ ride, passengers: [creator, leaver] });

    await run({ rideId }, asUser(leaver.userId));

    expect(ride.status).toBe('cancelled');
    expect(ride.cancellationReason).toBe('Only one passenger remaining. Ride cancelled.');
    expect(creator.status).toBe('cancelled');
    expect(io.payloadTo(`user:${creatorId}`, 'ride:cancelled')).toBeDefined();
    expect(io.payloadTo(`driver:${driverA}`, 'ride:cancelled-by-rider').message).toBe('All passengers cancelled.');
    expect(ack).toHaveBeenCalledWith({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true } });
  });

  it('the only rider on a split ride cancels (not the creator): ride cancelled with reason "Last passenger cancelled"', async () => {
    const only = makePassenger({ userId: creatorId });
    const ride = split({ notifiedDriverIds: [driverA], rideCreatedBy: oidStr() });
    wire({ ride, passengers: [only] });

    await run({ rideId });

    expect(ride.cancellationReason).toBe('Last passenger cancelled');
    expect(io.payloadTo(`driver:${driverA}`, 'ride:cancelled-by-rider').message).toBe('All passengers cancelled.');
  });
});

describe('KNOWN BUGS (documented; each asserts the CORRECT behaviour and currently fails by design)', () => {
  // BUG-REPORT CANCEL-5 | high | rideCancelBeforeAccept.handler.ts:97-101
  // A pending ride's card is pre-authorised at booking time (payment.service createPaymentIntent,
  // capture_method 'manual'). This handler cancels the passenger and the ride but never releases
  // that hold (no PaymentService.cancelAuthorizedBookingPayment, no booking/payment update). The
  // rider's card stays held until the authorisation expires. Fix: release the hold, as
  // driverCancelRide / rideCancelAfterAccept do, before recording the cancellation.
  it.fails('BUG CANCEL-5: a rider who cancels a pending ride must have the card authorisation released', async () => {
    const rider = oidStr();
    const p = makePassenger({ userId: rider });
    const booking = mockDoc({ _id: oidStr(), passengerId: String(p._id), rideId, userId: rider, paymentStatus: 'authorized' });
    wire({ ride: makeRide(), passengers: [p], bookings: [booking] });

    await run({ rideId }, asUser(rider));

    expect(PaymentService.cancelAuthorizedBookingPayment).toHaveBeenCalledWith(String(booking._id));
  });

  // BUG-REPORT CANCEL-6 | medium | rideCancelBeforeAccept.handler.ts:188-191
  // "remaining" uses status $ne cancelled, so passengers the driver REJECTED are counted as riders
  // still on the ride. With one real rider left plus a rejected one the ride is not cancelled and the
  // lone rider keeps waiting. The other handlers use $nin [cancelled, rejected]. Fix: match them.
  it.fails('BUG CANCEL-6: a rejected passenger must not count as a remaining rider (ride cancels when only one real rider is left)', async () => {
    const leaver = makePassenger({ userId: oidStr() });
    const real = makePassenger({ userId: oidStr() });
    const rejected = makePassenger({ userId: oidStr(), status: 'rejected' });
    const ride = makeRide({ type: 'split' });
    wire({ ride, passengers: [leaver, real, rejected] });

    await run({ rideId }, asUser(leaver.userId));

    expect(ride.status).toBe('cancelled');
  });

  // BUG-REPORT CANCEL-7 | low | rideCancelBeforeAccept.handler.ts:88
  // Cancelling a ride that is already cancelled answers "Cannot cancel: driver already accepted",
  // which is false and misleads the rider. Fix: return a status-specific message (e.g. "Ride is no
  // longer pending") for any non-pending status.
  it.fails('BUG CANCEL-7: a repeat cancel of an already cancelled ride must not claim the driver accepted it', async () => {
    const rider = oidStr();
    wire({ ride: makeRide({ status: 'cancelled' }), passengers: [makePassenger({ userId: rider })] });
    await run({ rideId }, asUser(rider));
    expect(ack).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Cannot cancel: driver already accepted' }),
    );
  });
});
