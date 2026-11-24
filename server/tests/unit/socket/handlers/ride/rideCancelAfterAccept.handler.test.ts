/**
 * Unit tests: `ride:cancel-after-accept` socket handler (rider cancels an accepted/started ride).
 *
 * Real: `calculateCancellationRefund` and `getRefundRestrictionHours` (time-window policy), so the
 * restriction boundaries are tested against the real rules. Mocked: wallet/split side effects.
 * Money: euro decimals, 2dp. Refund checklist from CLAUDE.md is asserted on the happy path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('stripe', async () => {
  const { createStripeMock } = await import('@tests/helpers/stripeMock');
  const instance = createStripeMock();
  return { default: vi.fn(function () { return instance; }) };
});
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
vi.mock('@src/app/modules/refund/refund.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Refund: createModelMock() };
});
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
});
vi.mock('@src/app/modules/payment/payment.service', () => ({
  PaymentService: { cancelAuthorizedBookingPayment: vi.fn() },
}));
vi.mock('@src/app/utils/notifyUser.utils', () => {
  const notifyUserPush = vi.fn();
  // Handlers push in the background; route it to the same spy.
  return { notifyUserPush, notifyUserPushInBackground: (input: any) => notifyUserPush(input) };
});
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));
vi.mock('@src/app/utils/splitFare.utils', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    recalculateSplitFares: vi.fn(),
    refundToWallet: vi.fn(),
    transferRideOwnership: vi.fn(),
  };
});

import { Booking } from '@src/app/modules/booking/booking.model';
import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { Payment } from '@src/app/modules/payment/payment.model';
import { PaymentService } from '@src/app/modules/payment/payment.service';
import { Refund } from '@src/app/modules/refund/refund.model';
import { Ride } from '@src/app/modules/ride/ride.model';
import { Setting } from '@src/app/modules/settings/settings.model';
import { User } from '@src/app/modules/user/user.model';
import { rideCancelAfterAcceptHandler } from '@src/app/socket/handlers/ride/rideCancelAfterAccept.handler';
import { getIO } from '@src/app/socket/socket.init';
import { notifyUserPush } from '@src/app/utils/notifyUser.utils';
import { recalculateSplitFares, refundToWallet, transferRideOwnership } from '@src/app/utils/splitFare.utils';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockDoc, mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, createMockSocket, type MockIo } from '@tests/helpers/socket';
import { freezeTime } from '@tests/helpers/time';

type Doc = Record<string, any>;

const ACTIVE = ['pending', 'confirmed', 'driver_arrived', 'in_progress', 'picked_up'];
const driverId = oidStr();
const rideId = oidStr();
const riderId = oidStr();

// Private ride departs 2026-03-20 12:00 Nicosia (UTC+2) = 10:00Z
const PRIVATE_DEPARTURE = { departureDate: '2026-03-20', departureTime: '12:00' };
// Split ride departs 2026-03-23 12:00 Nicosia = 10:00Z, i.e. far outside any restriction from 2026-03-20
const SPLIT_DEPARTURE = { departureDate: '2026-03-23', departureTime: '12:00' };

// ── tiny in-memory fakes (only the filter operators these handlers use) ──
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
  countDocuments: (filter: Doc = {}) => mockQuery(docs.filter((d) => matchOne(d, filter)).length),
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
  bookings: any[];
  payments: any[];
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
  vi.mocked(Passenger.countDocuments).mockImplementation(passengers.countDocuments as any);
  vi.mocked(Passenger.findByIdAndUpdate).mockImplementation(((id: unknown, update: Doc) => {
    applyUpdate(byId(w.passengers, id), update);
    return mockQuery(byId(w.passengers, id));
  }) as any);
  vi.mocked(Booking.findOne).mockImplementation(collection(w.bookings).findOne as any);
  vi.mocked(Payment.findOne).mockImplementation(collection(w.payments).findOne as any);
};

const makeRide = (o: Doc = {}): Doc => ({
  _id: rideId,
  type: 'private',
  status: 'accepted',
  driverId,
  rideCreatedBy: riderId,
  bookedSeats: 1,
  totalSeats: 4,
  ...PRIVATE_DEPARTURE,
  ...o,
});

const makePassenger = (o: Doc = {}): Doc => ({
  _id: oidStr(),
  rideId,
  userId: riderId,
  status: 'confirmed',
  requestedSeats: 1,
  malePassengers: 0,
  femalePassengers: 0,
  estimatedFare: 30,
  ...o,
});

/** Booking + captured payment for a passenger (euros). */
const paidBooking = (p: Doc, amountPaid = 25.5, providerEarning = 20.4) => {
  const tag = String(p._id).slice(-6);
  const booking = mockDoc({
    _id: oidStr(),
    passengerId: String(p._id),
    rideId,
    userId: p.userId,
    bookingStatus: 'accepted',
    paymentStatus: 'paid',
    amountPaid,
    transactionId: `pi_${tag}`,
  });
  const payment = mockDoc({
    _id: oidStr(),
    booking: String(booking._id),
    status: 'paid',
    isPaid: true,
    providerEarning,
    transactionId: `txn_${tag}`,
  });
  return { booking, payment };
};

const makeWorld = (ride: Doc, passengers: Doc[], paid: Array<{ booking: any; payment: any }> = []): World => ({
  ride,
  passengers,
  bookings: paid.map((x) => x.booking),
  payments: paid.map((x) => x.payment),
});

/** Restriction hours served by the Setting model (defaults: private 1h, split 24h). */
const setRestriction = (values: Record<string, number>) => {
  vi.mocked(Setting.findOne).mockImplementation(((filter: Doc) =>
    mockQuery(filter.key in values ? { key: filter.key, value: String(values[filter.key]) } : null)) as any);
};

let io: MockIo;
let ack: ReturnType<typeof vi.fn>;
let riderSocket: ReturnType<typeof createMockSocket>;

const run = (data: Doc, socket = riderSocket) =>
  rideCancelAfterAcceptHandler.call(socket as any, data, ack as any);
/** Socket authenticated as the rider who owns the passenger row being cancelled. */
const asUser = (userId: string) => createMockSocket({ userId, role: 'user' });

beforeEach(async () => {
  freezeTime('2026-03-20T07:00:00Z'); // 3h before the private departure
  io = createMockIo();
  vi.mocked(getIO).mockReturnValue(io as any);
  vi.mocked(transferRideOwnership).mockResolvedValue(true);
  setRestriction({});
  ack = vi.fn();
  riderSocket = createMockSocket({ userId: riderId, role: 'user' });
  await fakeRedis.hset(`driver:${driverId}:details`, { bookedSeats: '3' });
});

describe('ride:cancel-after-accept - input & stage guards', () => {
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

  it.each(['pending', 'rejected', 'completed', 'cancelled'])(
    'refuses to cancel a ride in status %s',
    async (status) => {
      const p = makePassenger();
      wire(makeWorld(makeRide({ status }), [p], [paidBooking(p)]));
      await run({ rideId });
      expect(ack).toHaveBeenCalledWith({ success: false, message: 'Cannot cancel at this stage' });
      expect(Passenger.findOne).not.toHaveBeenCalled();
      expect(refundToWallet).not.toHaveBeenCalled();
    },
  );

  it('accepts a ride that has already started', async () => {
    const p = makePassenger();
    wire(makeWorld(makeRide({ status: 'started' }), [p], [paidBooking(p)]));
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('split ride: requires a passengerId', async () => {
    wire(makeWorld(makeRide({ type: 'split', ...SPLIT_DEPARTURE }), [makePassenger()]));
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: 'passengerId is required for split ride cancellation',
    });
  });

  it('a rider cannot cancel someone else\'s booking ("No active booking found")', async () => {
    const other = makePassenger({ userId: oidStr() });
    wire(makeWorld(makeRide({ type: 'split', ...SPLIT_DEPARTURE }), [other]));
    await run({ rideId, passengerId: other._id });
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'No active booking found' });
    expect(refundToWallet).not.toHaveBeenCalled();
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('private ride: the rider\'s own active passenger is looked up with the exact filter', async () => {
    const p = makePassenger();
    wire(makeWorld(makeRide(), [p], [paidBooking(p)]));
    await run({ rideId });
    expect(Passenger.findOne).toHaveBeenCalledWith({ rideId, userId: riderId, status: { $in: ACTIVE } });
  });

  it('no active booking for this rider -> "No active booking found"', async () => {
    wire(makeWorld(makeRide(), [makePassenger({ status: 'cancelled' })]));
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'No active booking found' });
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});

describe('ride:cancel-after-accept - PRIVATE ride refund window', () => {
  it('a driver earning that WAS credited (ride.driverEarningCredited) is reverted', async () => {
    const p = makePassenger();
    wire(makeWorld(makeRide({ driverEarningCredited: true }), [p], [paidBooking(p, 25.5, 20.4)]));

    await run({ rideId, reason: 'Changed plans' });

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(driverId, { $inc: { wallet: -20.4 } });
  });

  it('outside the window: full refund to wallet, booking/payment refunded, driver NOT debited, Refund created', async () => {
    const p = makePassenger();
    const { booking, payment } = paidBooking(p, 25.5, 20.4);
    const ride = makeRide();
    wire(makeWorld(ride, [p], [{ booking, payment }]));

    await run({ rideId, reason: 'Changed plans' });

    // 3h before departure, restriction 1h -> refund everything
    expect(refundToWallet).toHaveBeenCalledWith(riderId, 25.5, 'cancel_outside_refund_restriction_window', io);

    expect(booking.bookingStatus).toBe('cancelled');
    expect(booking.refundAmount).toBe(25.5);
    expect(booking.paymentStatus).toBe('refunded');
    expect(booking.save).toHaveBeenCalledTimes(1);

    expect(payment.status).toBe('refunded');
    expect(payment.isPaid).toBe(false);

    // The earning is credited only at completion: nothing to claw back yet.
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();

    expect(Refund.create).toHaveBeenCalledWith({
      user: riderId,
      ride: rideId,
      type: 'cancel_ride',
      paymentIntentId: booking.transactionId,
      amount: 25.5,
      reason: 'Rider cancelled: Changed plans',
      note: `Ride ${rideId} cancelled by rider. Reason: outside_refund_restriction_window`,
      status: 'confirmed',
    });

    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(p._id, {
      status: 'cancelled',
      cancellationReason: 'Changed plans',
      cancelledBy: 'user',
      refundAmount: 25.5,
    });
    expect(Ride.findByIdAndUpdate).toHaveBeenNthCalledWith(1, rideId, {
      $inc: expect.objectContaining({ bookedSeats: -1 }),
    });
    expect(Ride.findByIdAndUpdate).toHaveBeenLastCalledWith(rideId, {
      status: 'cancelled',
      cancellationReason: 'Changed plans',
      cancelledBy: 'user',
      cancelledAt: new Date('2026-03-20T07:00:00Z'),
    });
    expect(await fakeRedis.hget(`driver:${driverId}:details`, 'bookedSeats')).toBe('2');

    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Ride cancelled.',
      data: {
        refundAmount: 25.5,
        refundReason: 'outside_refund_restriction_window',
        // B-04: the fee actually applied is returned so the app can show it.
        paidAmount: 25.5,
        feeAmount: 0,
        feePercent: 0,
        refundDestination: 'wallet',
        rideCancelled: true,
      },
    });
  });

  it('sends the cancelling rider ride:cancelled with the same fee fields as the ack', async () => {
    const p = makePassenger();
    wire(makeWorld(makeRide(), [p], [paidBooking(p)]));
    await run({ rideId, reason: 'Changed plans' });

    expect(io.payloadTo(`user:${riderId}`, 'ride:cancelled')).toEqual({
      rideId,
      passengerId: String(p._id),
      cancelledBy: 'user',
      refundAmount: 25.5,
      refundReason: 'outside_refund_restriction_window',
      paidAmount: 25.5,
      feeAmount: 0,
      feePercent: 0,
      refundDestination: 'wallet',
      message: 'Your ride has been cancelled. €25.50 has been refunded to your wallet.',
    });
  });

  it('notifies the driver on the socket and by push, carrying the refund amount', async () => {
    const p = makePassenger();
    wire(makeWorld(makeRide(), [p], [paidBooking(p)]));
    await run({ rideId, reason: 'Changed plans' });

    expect(io.payloadTo(`driver:${driverId}`, 'ride:cancelled-by-rider')).toEqual({
      rideId,
      message: 'Changed plans',
      refundAmount: 25.5,
    });
    expect(notifyUserPush).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: driverId,
        message: 'Ride Cancelled by Rider',
        description: 'Changed plans',
        data: { type: 'RIDE_CANCELLED_BY_RIDER', rideId },
      }),
    );
  });

  it('clears the live ride keys in Redis', async () => {
    const p = makePassenger();
    wire(makeWorld(makeRide(), [p], [paidBooking(p)]));
    await fakeRedis.set(`ride:active:${rideId}`, '1');
    await fakeRedis.set(`ride:request:${rideId}`, '1');
    await fakeRedis.zadd('ride:matching:queue', 1, rideId);
    await run({ rideId });
    expect(await fakeRedis.exists(`ride:active:${rideId}`)).toBe(0);
    expect(await fakeRedis.exists(`ride:request:${rideId}`)).toBe(0);
    expect(await fakeRedis.zscore('ride:matching:queue', rideId)).toBeNull();
  });

  it('boundary: exactly at the restriction limit (1h before departure) is RESTRICTED: no refund', async () => {
    freezeTime('2026-03-20T09:00:00Z'); // hours before departure = 1.0
    const p = makePassenger();
    const { booking, payment } = paidBooking(p);
    wire(makeWorld(makeRide(), [p], [{ booking, payment }]));

    await run({ rideId });

    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Ride cancelled.',
      data: {
        refundAmount: 0,
        refundReason: 'private_refund_restricted_1h_before_pickup',
        // B-04: inside the restriction window the whole amount is the fee.
        paidAmount: 25.5,
        feeAmount: 25.5,
        feePercent: 100,
        refundDestination: null,
        rideCancelled: true,
      },
    });
    expect(refundToWallet).not.toHaveBeenCalled();
    expect(Refund.create).not.toHaveBeenCalled();
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(booking.paymentStatus).toBe('paid'); // nothing refunded, status untouched
    expect(booking.bookingStatus).toBe('cancelled');
    expect(payment.status).toBe('paid');
    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(p._id, expect.objectContaining({ refundAmount: 0 }));
  });

  it('boundary: one minute outside the restriction limit still gets the full refund', async () => {
    freezeTime('2026-03-20T08:59:00Z'); // 61 minutes before departure
    const p = makePassenger();
    wire(makeWorld(makeRide(), [p], [paidBooking(p)]));
    await run({ rideId });
    expect(refundToWallet).toHaveBeenCalledWith(riderId, 25.5, 'cancel_outside_refund_restriction_window', io);
  });

  it('after departure: no refund, the full amount is kept by the platform', async () => {
    freezeTime('2026-03-20T10:00:01Z');
    const p = makePassenger();
    wire(makeWorld(makeRide(), [p], [paidBooking(p)]));
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refundAmount: 0, refundReason: 'cancelled_after_departure' }),
      }),
    );
    expect(refundToWallet).not.toHaveBeenCalled();
  });

  it('a window setting overrides the default: private restriction 2h makes 1.5h-before RESTRICTED', async () => {
    freezeTime('2026-03-20T08:30:00Z'); // 1.5h before departure
    setRestriction({ privateRideRefundRestrictionHours: 2 });
    const p = makePassenger();
    wire(makeWorld(makeRide(), [p], [paidBooking(p)]));
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refundAmount: 0, refundReason: 'private_refund_restricted_2h_before_pickup' }),
      }),
    );
  });

  it('no driver assigned: nothing is debited or pushed to a driver, but the rider is still refunded', async () => {
    const p = makePassenger();
    wire(makeWorld(makeRide({ driverId: undefined }), [p], [paidBooking(p)]));
    await run({ rideId });
    expect(refundToWallet).toHaveBeenCalledWith(riderId, 25.5, 'cancel_outside_refund_restriction_window', io);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(notifyUserPush).not.toHaveBeenCalled();
  });

  it('no booking at all: nothing is refunded and the ride is still cancelled', async () => {
    wire(makeWorld(makeRide(), [makePassenger()], []));
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Ride cancelled.',
      data: {
        refundAmount: 0,
        refundReason: 'no_amount_paid',
        paidAmount: 0,
        feeAmount: 0,
        feePercent: 0,
        refundDestination: null,
        rideCancelled: true,
      },
    });
    expect(refundToWallet).not.toHaveBeenCalled();
    expect(Refund.create).not.toHaveBeenCalled();
  });

  it('authorization hold: the hold is released and nothing is refunded (no Refund, no wallet)', async () => {
    const p = makePassenger();
    const booking = mockDoc({ _id: oidStr(), passengerId: String(p._id), rideId, userId: riderId, paymentStatus: 'authorized', amountPaid: 0 });
    const payment = mockDoc({ _id: oidStr(), booking: String(booking._id), status: 'authorized', isPaid: false });
    wire(makeWorld(makeRide(), [p], [{ booking, payment }]));

    await run({ rideId });

    expect(PaymentService.cancelAuthorizedBookingPayment).toHaveBeenCalledWith(String(booking._id));
    expect(refundToWallet).not.toHaveBeenCalled();
    expect(Refund.create).not.toHaveBeenCalled();
    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(p._id, expect.objectContaining({ refundAmount: 0 }));
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('Stripe hold release fails: nothing is written', async () => {
    const p = makePassenger();
    const booking = mockDoc({ _id: oidStr(), passengerId: String(p._id), rideId, userId: riderId, paymentStatus: 'authorized', amountPaid: 0 });
    const payment = mockDoc({ _id: oidStr(), booking: String(booking._id), status: 'authorized', isPaid: false });
    wire(makeWorld(makeRide(), [p], [{ booking, payment }]));
    vi.mocked(PaymentService.cancelAuthorizedBookingPayment).mockRejectedValueOnce(new Error('Stripe is down'));

    await run({ rideId });

    // B-22: unexpected errors are not echoed verbatim; the ack carries a code instead.
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong!' }),
    );
    expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(booking.save).not.toHaveBeenCalled();
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(refundToWallet).not.toHaveBeenCalled();
    expect(io.emitted).toHaveLength(0);
  });

  it('idempotent: a repeat cancel after success is refused and does not refund twice', async () => {
    const p = makePassenger();
    wire(makeWorld(makeRide(), [p], [paidBooking(p)]));
    await run({ rideId });
    await run({ rideId });
    expect(ack).toHaveBeenLastCalledWith({ success: false, message: 'Cannot cancel at this stage' });
    expect(refundToWallet).toHaveBeenCalledTimes(1);
    expect(Refund.create).toHaveBeenCalledTimes(1);
  });
});

describe('ride:cancel-after-accept - SPLIT ride', () => {
  // now = 2026-03-20T07:00Z, departure 2026-03-23 10:00Z -> well outside the 24h split restriction
  const splitRide = (o: Doc = {}) => makeRide({ type: 'split', ...SPLIT_DEPARTURE, ...o });

  it('split restriction boundary: exactly 24h before departure is RESTRICTED', async () => {
    freezeTime('2026-03-22T10:00:00Z'); // exactly 24h before the 23rd 10:00Z departure
    const p1 = makePassenger();
    const p2 = makePassenger({ userId: oidStr() });
    const p3 = makePassenger({ userId: oidStr() });
    wire(makeWorld(splitRide({ rideCreatedBy: oidStr() }), [p1, p2, p3], [paidBooking(p2)]));
    await run({ rideId, passengerId: p2._id }, asUser(p2.userId));
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refundAmount: 0, refundReason: 'split_refund_restricted_24h_before_pickup' }),
      }),
    );
    expect(refundToWallet).not.toHaveBeenCalled();
  });

  it('split restriction boundary: one minute before the 24h limit gets the full refund', async () => {
    freezeTime('2026-03-22T09:59:00Z');
    const p1 = makePassenger();
    const p2 = makePassenger({ userId: oidStr() });
    const p3 = makePassenger({ userId: oidStr() });
    wire(makeWorld(splitRide({ rideCreatedBy: oidStr() }), [p1, p2, p3], [paidBooking(p2)]));
    await run({ rideId, passengerId: p2._id }, asUser(p2.userId));
    expect(refundToWallet).toHaveBeenCalledWith(p2.userId, 25.5, 'cancel_outside_refund_restriction_window', io);
  });

  it('a non-creator rider leaves 3 riders: refunded, fares recalculated, driver told, co-riders notified', async () => {
    const creator = makePassenger({ userId: oidStr() });
    const leaver = makePassenger({ userId: oidStr() });
    const other = makePassenger({ userId: oidStr() });
    const ride = splitRide({ rideCreatedBy: creator.userId });
    wire(makeWorld(ride, [creator, leaver, other], [paidBooking(leaver)]));

    await run({ rideId, passengerId: leaver._id, reason: 'Changed plans' }, asUser(leaver.userId));

    expect(refundToWallet).toHaveBeenCalledWith(leaver.userId, 25.5, 'cancel_outside_refund_restriction_window', io);
    expect(recalculateSplitFares).toHaveBeenCalledWith(rideId, 'passenger_cancelled', io);
    expect(io.payloadTo(`driver:${driverId}`, 'ride:cancelled-by-rider')).toEqual({
      rideId,
      message: 'A passenger cancelled. 2 passenger(s) remaining.',
      passengerId: leaver._id,
      remainingPassengers: 2,
    });
    for (const co of [creator, other]) {
      expect(io.payloadTo(`user:${co.userId}`, 'ride:co-passenger-cancelled')).toEqual({
        rideId,
        cancelledPassengerId: leaver._id,
        message: 'Another passenger cancelled their booking.',
      });
    }
    expect(ride.status).toBe('accepted');
    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Booking cancelled.',
      data: {
        passengerId: leaver._id,
        refundAmount: 25.5,
        refundReason: 'outside_refund_restriction_window',
        paidAmount: 25.5,
        feeAmount: 0,
        feePercent: 0,
        refundDestination: 'wallet',
        rideCancelled: false,
        remainingPassengers: 2,
      },
    });
  });

  it('a rider leaves a 2-rider ride -> ride cancelled, no fare recalculation', async () => {
    const creator = makePassenger({ userId: oidStr() });
    const leaver = makePassenger({ userId: oidStr() });
    const ride = splitRide({ rideCreatedBy: creator.userId });
    wire(makeWorld(ride, [creator, leaver], [paidBooking(leaver)]));

    await run({ rideId, passengerId: leaver._id }, asUser(leaver.userId));

    expect(ride.status).toBe('cancelled');
    expect(ride.cancellationReason).toBe('Only one passenger remaining. Ride cancelled.');
    expect(recalculateSplitFares).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Ride cancelled - only one passenger remaining.',
      data: {
        refundAmount: 25.5,
        refundReason: 'outside_refund_restriction_window',
        paidAmount: 25.5,
        feeAmount: 0,
        feePercent: 0,
        refundDestination: 'wallet',
        rideCancelled: true,
      },
    });
  });

  it('the ride creator leaves and ONE rider remains -> ride cancelled, creator-specific reason', async () => {
    const creator = makePassenger({ userId: riderId });
    const other = makePassenger({ userId: oidStr() });
    const ride = splitRide({ rideCreatedBy: riderId });
    wire(makeWorld(ride, [creator, other], [paidBooking(creator)]));

    await run({ rideId, passengerId: creator._id });

    expect(ride.status).toBe('cancelled');
    expect(ride.cancellationReason).toBe('Creator cancelled, only one passenger remaining. Ride cancelled.');
    expect(transferRideOwnership).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: 'Ride cancelled - only one passenger remaining.' }),
    );
  });

  it('the ride creator leaves and TWO riders remain -> ownership is transferred and the ride continues', async () => {
    const creator = makePassenger({ userId: riderId });
    const b = makePassenger({ userId: oidStr() });
    const c = makePassenger({ userId: oidStr() });
    const ride = splitRide({ rideCreatedBy: riderId });
    wire(makeWorld(ride, [creator, b, c], [paidBooking(creator)]));

    await run({ rideId, passengerId: creator._id });

    expect(transferRideOwnership).toHaveBeenCalledWith(rideId, riderId, io);
    expect(ride.status).toBe('accepted');
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ rideCancelled: false, remainingPassengers: 2 }),
      }),
    );
  });

  it('a pending (not yet paid) rider leaving a split ride refunds nothing', async () => {
    const creator = makePassenger({ userId: oidStr() });
    const leaver = makePassenger({ userId: oidStr(), status: 'pending', estimatedFare: 0 });
    const ride = splitRide({ rideCreatedBy: creator.userId });
    const other = makePassenger({ userId: oidStr() });
    wire(makeWorld(ride, [creator, leaver, other], []));

    await run({ rideId, passengerId: leaver._id }, asUser(leaver.userId));

    expect(refundToWallet).not.toHaveBeenCalled();
    expect(Refund.create).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ refundAmount: 0 }) }));
  });
});

describe('FIXED BUGS (regression tests)', () => {
  // BUG-REPORT CANCEL-2 | high | rideCancelAfterAccept.handler.ts:124
  // When no money was captured and no hold exists, the handler falls back to passenger.estimatedFare
  // as the "paid" amount, so a rider whose payment never succeeded is refunded (wallet credit +
  // Refund document) for a fare they never paid. Fix: use booking.amountPaid only; treat 0 as 0.
  it('BUG CANCEL-2: a rider whose payment never captured money must not be refunded the estimated fare', async () => {
    const p = makePassenger({ estimatedFare: 30 });
    const booking = mockDoc({ _id: oidStr(), passengerId: String(p._id), rideId, userId: riderId, paymentStatus: 'failed', amountPaid: 0 });
    const payment = mockDoc({ _id: oidStr(), booking: String(booking._id), status: 'failed', isPaid: false });
    wire(makeWorld(makeRide(), [p], [{ booking, payment }]));

    await run({ rideId });

    expect(refundToWallet).not.toHaveBeenCalled();
    expect(Refund.create).not.toHaveBeenCalled();
  });

  // BUG-REPORT CANCEL-3 | high | rideCancelAfterAccept.handler.ts:137-184
  // The passenger is marked cancelled and the booking is finalised BEFORE the wallet credit. If
  // refundToWallet fails, the rider is no longer "active", so a retry returns "No active booking
  // found" and the rider can never receive the refund. Fix: credit the wallet first (idempotently)
  // or keep the passenger retryable until the credit succeeds.
  it('BUG CANCEL-3: a rider whose wallet credit failed must be able to retry and receive the refund', async () => {
    const p = makePassenger();
    const { booking, payment } = paidBooking(p);
    wire(makeWorld(makeRide(), [p], [{ booking, payment }]));
    vi.mocked(refundToWallet).mockRejectedValueOnce(new Error('wallet down'));

    await run({ rideId });
    await run({ rideId });

    expect(vi.mocked(refundToWallet).mock.calls.length).toBe(2);
  });

  // BUG-REPORT CANCEL-4 | high | rideCancelAfterAccept.handler.ts:316-335
  // Split ride: when the rider's departure leaves ONE passenger, the ride is cancelled but the
  // remaining passenger is neither cancelled, refunded nor notified (only the driver is told). That
  // rider stays "confirmed" on a cancelled ride with their money captured. Same gap at lines 250-270
  // for the creator branch. Fix: cancel/refund/notify the lone remaining passenger, as the
  // driver-cancel and before-accept handlers already do.
  it('BUG CANCEL-4: the lone remaining rider of a cancelled split ride must be told the ride is gone', async () => {
    const leaver = makePassenger({ userId: oidStr() });
    const lone = makePassenger({ userId: oidStr() });
    const ride = makeRide({ type: 'split', ...SPLIT_DEPARTURE, rideCreatedBy: oidStr() });
    wire(makeWorld(ride, [leaver, lone], [paidBooking(leaver)]));

    await run({ rideId, passengerId: leaver._id }, asUser(leaver.userId));

    expect(ride.status).toBe('cancelled');
    expect(io.emittedTo(`user:${lone.userId}`).length).toBeGreaterThan(0);
  });
});
