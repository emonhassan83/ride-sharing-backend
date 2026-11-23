/**
 * Unit tests: `driver:cancel-ride` socket handler (driver removes a rider or ends a ride).
 *
 * Money: amounts are euro decimals (2dp), as stored by the app; `refundToWallet` (mocked here)
 * owns the 2dp rounding. Refund checklist from CLAUDE.md: wallet credit, booking/payment
 * refunded, driver providerEarning debited, Refund document created.
 *
 * Models are in-memory fakes (see `collection`) so a second call sees what the first wrote.
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
vi.mock('@src/app/modules/refund/refund.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Refund: createModelMock() };
});
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/payment/payment.service', () => ({
  PaymentService: { cancelAuthorizedBookingPayment: vi.fn() },
}));
vi.mock('@src/app/utils/notifyUser.utils', () => ({ notifyUserPush: vi.fn() }));
vi.mock('@src/app/utils/splitFare.utils', () => ({ refundToWallet: vi.fn() }));
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));

import { Booking } from '@src/app/modules/booking/booking.model';
import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { Payment } from '@src/app/modules/payment/payment.model';
import { PaymentService } from '@src/app/modules/payment/payment.service';
import { Refund } from '@src/app/modules/refund/refund.model';
import { Ride } from '@src/app/modules/ride/ride.model';
import { User } from '@src/app/modules/user/user.model';
import { driverCancelRideHandler } from '@src/app/socket/handlers/ride/driverCancelRide.handler';
import { getIO } from '@src/app/socket/socket.init';
import { notifyUserPush } from '@src/app/utils/notifyUser.utils';
import { refundToWallet } from '@src/app/utils/splitFare.utils';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockDoc, mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, createMockSocket, type MockIo } from '@tests/helpers/socket';
import { freezeTime } from '@tests/helpers/time';

type Doc = Record<string, any>;

const NOW = '2026-03-20T00:00:00Z';
const ACTIVE = ['confirmed', 'driver_arrived', 'in_progress', 'picked_up'];
const rideId = oidStr();
const driverId = oidStr();
const riderId = oidStr();

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
  vi.mocked(Passenger.findById).mockImplementation(((id: unknown) =>
    mockQuery(byId(w.passengers, id))) as any);
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
  bookedSeats: 1,
  totalSeats: 4,
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
  ...o,
});

/** A paid booking + its captured payment for a passenger (amounts in euros). */
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
    paymentIntentId: `pi_pay_${tag}`,
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

let io: MockIo;
let ack: ReturnType<typeof vi.fn>;
let driverSocket: ReturnType<typeof createMockSocket>;

const run = (data: Doc, socket = driverSocket) =>
  driverCancelRideHandler.call(socket as any, data, ack as any);

beforeEach(async () => {
  freezeTime(NOW);
  io = createMockIo();
  vi.mocked(getIO).mockReturnValue(io as any);
  ack = vi.fn();
  driverSocket = createMockSocket({ userId: driverId, role: 'provider' });
  await fakeRedis.hset(`driver:${driverId}:details`, { bookedSeats: '3' });
});

describe('driver:cancel-ride - input & ride guards', () => {
  it('requires a rideId', async () => {
    await run({});
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'Missing required fields' });
    expect(Ride.findById).not.toHaveBeenCalled();
  });

  it('requires an authenticated driver socket', async () => {
    const anonymous = createMockSocket();
    anonymous.auth = undefined;
    await run({ rideId }, anonymous);
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'Missing required fields' });
    expect(Ride.findById).not.toHaveBeenCalled();
  });

  it('reports a ride that does not exist', async () => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(null) as any);
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'Ride not found' });
  });

  it('refuses a ride assigned to another driver and changes nothing', async () => {
    wire(makeWorld(makeRide({ driverId: oidStr() }), [makePassenger()]));
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'Not assigned to this ride' });
    expect(Passenger.findOne).not.toHaveBeenCalled();
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(refundToWallet).not.toHaveBeenCalled();
  });

  it.each(['pending', 'rejected', 'completed', 'cancelled'])(
    'refuses to cancel a ride in status %s',
    async (status) => {
      wire(makeWorld(makeRide({ status }), [makePassenger()]));
      await run({ rideId });
      expect(ack).toHaveBeenCalledWith({ success: false, message: 'Cannot cancel now' });
      expect(Passenger.findOne).not.toHaveBeenCalled();
      expect(io.emitted).toHaveLength(0);
    },
  );

  it('answers "Unknown ride type" for a ride that is neither private nor split', async () => {
    wire(makeWorld(makeRide({ type: 'mystery' }), [makePassenger()]));
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'Unknown ride type' });
  });
});

describe('driver:cancel-ride - PRIVATE ride', () => {
  it('reports "No active passenger found" and writes nothing when no rider is active', async () => {
    wire(makeWorld(makeRide(), [makePassenger({ status: 'cancelled' })]));
    await run({ rideId });
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'No active passenger found' });
    expect(Booking.findOne).not.toHaveBeenCalled();
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(refundToWallet).not.toHaveBeenCalled();
  });

  it('looks up the active passenger of the ride by status when no passengerId is sent', async () => {
    const p = makePassenger();
    wire(makeWorld(makeRide(), [p], [paidBooking(p)]));
    await run({ rideId });
    expect(Passenger.findOne).toHaveBeenCalledWith({ rideId, status: { $in: ACTIVE } });
  });

  it('full refund: rider wallet credited exactly, booking & payment refunded, driver debited, Refund created', async () => {
    const passenger = makePassenger();
    const { booking, payment } = paidBooking(passenger, 25.5, 20.4);
    wire(makeWorld(makeRide(), [passenger], [{ booking, payment }]));

    await run({ rideId, reason: 'Car broke' });

    // rider's money goes back to the wallet, exact amount
    expect(refundToWallet).toHaveBeenCalledTimes(1);
    expect(refundToWallet).toHaveBeenCalledWith(riderId, 25.5, 'driver_cancelled', io);

    // booking: cancelled, refund amount recorded, paymentStatus refunded
    expect(booking.bookingStatus).toBe('cancelled');
    expect(booking.refundAmount).toBe(25.5);
    expect(booking.paymentStatus).toBe('refunded');
    expect(booking.save).toHaveBeenCalledTimes(1);

    // payment: refunded, no longer paid, saved
    expect(payment.status).toBe('refunded');
    expect(payment.isPaid).toBe(false);
    expect(payment.save).toHaveBeenCalledTimes(1);

    // driver: providerEarning clawed back from wallet
    expect(User.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(driverId, { $inc: { wallet: -20.4 } });

    // Refund document with the exact amount
    expect(Refund.create).toHaveBeenCalledWith({
      user: riderId,
      ride: rideId,
      type: 'cancel_ride',
      paymentIntentId: 'pi_' + String(passenger._id).slice(-6),
      amount: 25.5,
      reason: 'Driver cancelled: Car broke',
      note: `Ride ${rideId} cancelled by driver`,
      status: 'confirmed',
    });

    // passenger & ride closed out
    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(passenger._id, {
      status: 'cancelled',
      cancellationReason: 'Car broke',
      cancelledBy: 'driver',
    });
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(rideId, {
      status: 'cancelled',
      cancellationReason: 'Car broke',
      cancelledBy: 'driver',
      cancelledAt: new Date(NOW),
    });
    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Private ride cancelled',
      data: { passengerCount: 1, rideCancelled: true, refundAmount: 25.5 },
    });
  });

  it('tells the rider the refund amount on the socket and by push', async () => {
    const passenger = makePassenger();
    wire(makeWorld(makeRide(), [passenger], [paidBooking(passenger)]));
    await run({ rideId, reason: 'Car broke' });

    expect(io.payloadTo(`user:${riderId}`, 'ride:cancelled-by-driver')).toEqual({
      rideId,
      passengerId: String(passenger._id),
      reason: 'Car broke',
      refundAmount: 25.5,
      message: 'Your ride has been cancelled by the driver. Refund added to your wallet.',
    });
    expect(notifyUserPush).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: riderId,
        message: 'Ride Cancelled by Driver',
        data: {
          type: 'RIDE_CANCELLED_BY_DRIVER',
          rideId,
          passengerId: String(passenger._id),
          refundAmount: 25.5,
        },
      }),
    );
  });

  it('defaults the reason to "Driver cancelled" when none is given', async () => {
    const passenger = makePassenger();
    wire(makeWorld(makeRide(), [passenger], [paidBooking(passenger)]));
    await run({ rideId });
    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(
      passenger._id,
      expect.objectContaining({ cancellationReason: 'Driver cancelled' }),
    );
  });

  it('releases the seat on the driver Redis hash (bookedSeats 3 -> 2 for a 1-seat rider)', async () => {
    const passenger = makePassenger();
    wire(makeWorld(makeRide(), [passenger], [paidBooking(passenger)]));
    await run({ rideId });
    expect(await fakeRedis.hget(`driver:${driverId}:details`, 'bookedSeats')).toBe('2');
  });

  it('clears the ride from every live-matching key in Redis', async () => {
    const passenger = makePassenger();
    wire(makeWorld(makeRide(), [passenger], [paidBooking(passenger)]));
    await fakeRedis.set(`ride:active:${rideId}`, '1');
    await fakeRedis.set(`ride:request:${rideId}`, '1');
    await fakeRedis.set(`driver:${driverId}:activeRide`, rideId);
    await fakeRedis.zadd('ride:matching:queue', 1, rideId);

    await run({ rideId });

    expect(await fakeRedis.exists(`ride:active:${rideId}`)).toBe(0);
    expect(await fakeRedis.exists(`ride:request:${rideId}`)).toBe(0);
    expect(await fakeRedis.exists(`driver:${driverId}:activeRide`)).toBe(0);
    expect(await fakeRedis.zscore('ride:matching:queue', rideId)).toBeNull();
  });

  it('no providerEarning: the rider is still refunded but the driver wallet is not debited', async () => {
    const passenger = makePassenger();
    wire(makeWorld(makeRide(), [passenger], [paidBooking(passenger, 25.5, 0)]));
    await run({ rideId });
    expect(refundToWallet).toHaveBeenCalledWith(riderId, 25.5, 'driver_cancelled', io);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Refund.create).toHaveBeenCalledTimes(1);
  });

  it.each(['authorized', 'requires_reauthorization'])(
    'authorization hold (%s, nothing captured): hold released, no refund, no Refund document',
    async (status) => {
      const passenger = makePassenger();
      const booking = mockDoc({
        _id: oidStr(),
        passengerId: String(passenger._id),
        rideId,
        userId: riderId,
        bookingStatus: 'accepted',
        paymentStatus: status,
        amountPaid: 0,
      });
      const payment = mockDoc({ _id: oidStr(), booking: String(booking._id), status, isPaid: false });
      wire(makeWorld(makeRide(), [passenger], [{ booking, payment }]));

      await run({ rideId });

      expect(PaymentService.cancelAuthorizedBookingPayment).toHaveBeenCalledWith(String(booking._id));
      expect(booking.bookingStatus).toBe('cancelled');
      expect(booking.refundAmount).toBe(0);
      expect(booking.paymentStatus).toBe('cancelled_authorization');
      expect(refundToWallet).not.toHaveBeenCalled();
      expect(Refund.create).not.toHaveBeenCalled();
      expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: expect.objectContaining({ refundAmount: 0 }) }),
      );
    },
  );

  it('Stripe hold release fails: nothing is written (booking, passenger, ride, wallets, Refund)', async () => {
    const passenger = makePassenger();
    const booking = mockDoc({
      _id: oidStr(),
      passengerId: String(passenger._id),
      rideId,
      userId: riderId,
      paymentStatus: 'authorized',
      amountPaid: 0,
    });
    const payment = mockDoc({ _id: oidStr(), booking: String(booking._id), status: 'authorized', isPaid: false });
    wire(makeWorld(makeRide(), [passenger], [{ booking, payment }]));
    vi.mocked(PaymentService.cancelAuthorizedBookingPayment).mockRejectedValueOnce(new Error('Stripe is down'));

    await run({ rideId });

    expect(ack).toHaveBeenCalledWith({ success: false, message: 'Stripe is down' });
    expect(booking.save).not.toHaveBeenCalled();
    expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(refundToWallet).not.toHaveBeenCalled();
    expect(Refund.create).not.toHaveBeenCalled();
    expect(io.emitted).toHaveLength(0);
  });

  it('wallet credit fails: the error is reported and the ride and rider are NOT marked cancelled', async () => {
    const passenger = makePassenger();
    const ride = makeRide();
    wire(makeWorld(ride, [passenger], [paidBooking(passenger)]));
    vi.mocked(refundToWallet).mockRejectedValueOnce(new Error('wallet down'));

    await run({ rideId });

    expect(ack).toHaveBeenCalledWith({ success: false, message: 'wallet down' });
    expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(ride.status).toBe('accepted');
    expect(await fakeRedis.hget(`driver:${driverId}:details`, 'bookedSeats')).toBe('3');
  });

  it('idempotent: a repeat cancel after success is refused and does not refund again', async () => {
    const passenger = makePassenger();
    wire(makeWorld(makeRide(), [passenger], [paidBooking(passenger)]));

    await run({ rideId });
    await run({ rideId });

    expect(ack).toHaveBeenLastCalledWith({ success: false, message: 'Cannot cancel now' });
    expect(refundToWallet).toHaveBeenCalledTimes(1);
    expect(Refund.create).toHaveBeenCalledTimes(1);
    expect(User.findByIdAndUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('driver:cancel-ride - SPLIT ride', () => {
  const split = (over: Doc = {}) => makeRide({ type: 'split', ...over });

  it('without passengerId: cancels the WHOLE ride, refunds every active rider, notifies the driver room', async () => {
    const p1 = makePassenger({ requestedSeats: 1 });
    const p2 = makePassenger({ requestedSeats: 2 });
    const ride = split({ bookedSeats: 3 });
    const b1 = paidBooking(p1, 25.5, 20.4);
    const b2 = paidBooking(p2, 10, 8);
    wire(makeWorld(ride, [p1, p2], [b1, b2]));
    await fakeRedis.zadd('ride:matching:queue', 1, rideId);

    await run({ rideId, reason: 'Vehicle issue' });

    expect(refundToWallet).toHaveBeenCalledTimes(2);
    expect(refundToWallet).toHaveBeenNthCalledWith(1, riderId, 25.5, 'driver_cancelled', io);
    expect(refundToWallet).toHaveBeenNthCalledWith(2, riderId, 10, 'driver_cancelled', io);
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(driverId, { $inc: { wallet: -20.4 } });
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(driverId, { $inc: { wallet: -8 } });
    expect(p1.status).toBe('cancelled');
    expect(p2.status).toBe('cancelled');
    expect(p1.cancellationReason).toBe('Vehicle issue');
    expect(ride.status).toBe('cancelled');
    expect(ride.cancelledBy).toBe('driver');
    expect(await fakeRedis.hget(`driver:${driverId}:details`, 'bookedSeats')).toBe('0');
    expect(await fakeRedis.zscore('ride:matching:queue', rideId)).toBeNull();

    expect(io.payloadTo(`driver:${driverId}`, 'ride:cancelled-by-driver')).toEqual({
      rideId,
      reason: 'Vehicle issue',
      message: 'Entire ride cancelled. 2 passenger(s) notified and refunded.',
    });
    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Entire split ride cancelled. 2 passenger(s) affected.',
      data: { rideCancelled: true, cancelledPassengerCount: 2, totalRefunded: 35.5 },
    });
  });

  it('without passengerId: a ride with no active riders is cancelled with zero refunds', async () => {
    const ride = split();
    wire(makeWorld(ride, [], []));
    await run({ rideId });
    expect(refundToWallet).not.toHaveBeenCalled();
    expect(ride.status).toBe('cancelled');
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ cancelledPassengerCount: 0, totalRefunded: 0 }),
      }),
    );
  });

  it('with passengerId: rejects a passenger who is not active on this ride', async () => {
    const p1 = makePassenger({ status: 'cancelled' });
    wire(makeWorld(split(), [p1], []));
    await run({ rideId, passengerId: p1._id });
    expect(ack).toHaveBeenCalledWith({ success: false, message: 'Passenger not found or not active' });
    expect(refundToWallet).not.toHaveBeenCalled();
  });

  it('with passengerId: removing one of THREE riders refunds only that rider, cuts seats and keeps the ride alive', async () => {
    const p1 = makePassenger({ requestedSeats: 2, malePassengers: 1, femalePassengers: 1 });
    const p2 = makePassenger();
    const p3 = makePassenger();
    const ride = split({ bookedSeats: 4, totalSeats: 6 });
    wire(makeWorld(ride, [p1, p2, p3], [paidBooking(p1, 30, 24)]));
    await fakeRedis.hset(`driver:${driverId}:details`, { bookedSeats: '4' });

    await run({ rideId, passengerId: p1._id, reason: 'Too far' });

    expect(refundToWallet).toHaveBeenCalledTimes(1);
    expect(refundToWallet).toHaveBeenCalledWith(riderId, 30, 'driver_cancelled', io);
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(rideId, {
      $inc: { bookedSeats: -2, malePassengers: -1, femalePassengers: -1 },
    });
    expect(ride.status).toBe('accepted');
    expect(await fakeRedis.hget(`driver:${driverId}:details`, 'bookedSeats')).toBe('2');

    // the two remaining riders are told the seats left (6 total - 2 booked after the cut)
    for (const p of [p2, p3]) {
      expect(io.payloadTo(`user:${p.userId}`, 'ride:co-passenger-cancelled')).toEqual({
        rideId,
        cancelledPassengerId: p1._id,
        remainingSeats: 4,
        message: 'A passenger has been removed by the driver.',
      });
    }
    expect(notifyUserPush).toHaveBeenCalledTimes(3); // removed rider (refund) + 2 co-passengers
    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Passenger cancelled from split ride.',
      data: { remainingPassengers: 2, rideCancelled: false, refundAmount: 30 },
    });
  });

  it('with passengerId: removing a rider leaves ONE rider -> whole ride cancelled, the last rider refunded', async () => {
    const p1 = makePassenger();
    const p2 = makePassenger();
    const ride = split({ bookedSeats: 2, totalSeats: 4 });
    wire(makeWorld(ride, [p1, p2], [paidBooking(p1, 20, 16), paidBooking(p2, 12, 9)]));
    await fakeRedis.zadd('ride:matching:queue', 1, rideId);
    await fakeRedis.set(`ride:request:${rideId}`, '1');

    await run({ rideId, passengerId: p1._id, reason: 'Too far' });

    expect(refundToWallet).toHaveBeenCalledWith(riderId, 20, 'driver_cancelled', io);
    expect(refundToWallet).toHaveBeenCalledWith(riderId, 12, 'driver_cancelled', io);
    expect(p2.status).toBe('cancelled');
    expect(p2.cancellationReason).toBe('Only one passenger remaining. Ride cancelled.');
    expect(ride.status).toBe('cancelled');
    expect(ride.cancellationReason).toBe('Only one passenger remaining. Ride cancelled.');
    expect(await fakeRedis.zscore('ride:matching:queue', rideId)).toBeNull();
    expect(await fakeRedis.exists(`ride:request:${rideId}`)).toBe(0);
    expect(ack).toHaveBeenCalledWith({
      success: true,
      message: 'Only one passenger remaining. Ride cancelled.',
      data: { remainingPassengers: 0, rideCancelled: true, refundAmount: 20 },
    });
  });

  it('with passengerId: removing the ONLY rider cancels the ride with reason "No passengers left"', async () => {
    const p1 = makePassenger();
    const ride = split();
    wire(makeWorld(ride, [p1], [paidBooking(p1, 15, 12)]));
    await run({ rideId, passengerId: p1._id });
    expect(ride.status).toBe('cancelled');
    expect(ride.cancellationReason).toBe('No passengers left');
    expect(refundToWallet).toHaveBeenCalledTimes(1);
  });
});

describe('FIXED BUGS (regression tests)', () => {
  // BUG-REPORT CANCEL-1 | high | driverCancelRide.handler.ts:88-99
  // The Refund document is created and the booking/payment are finalised BEFORE the wallet credit.
  // If refundToWallet fails the passenger stays active, so a retry re-runs the refund: a second
  // Refund document is created. Fix: guard on booking.bookingStatus (or a unique Refund key) and
  // finalise the booking only after the wallet credit succeeds.
  it('BUG CANCEL-1: retrying a driver cancel after a failed wallet credit must not create a second Refund', async () => {
    const passenger = makePassenger();
    const { booking, payment } = paidBooking(passenger, 25.5, 20.4);
    wire(makeWorld(makeRide(), [passenger], [{ booking, payment }]));
    vi.mocked(refundToWallet).mockRejectedValueOnce(new Error('wallet down'));

    await run({ rideId });
    await run({ rideId });

    expect(Refund.create).toHaveBeenCalledTimes(1);
  });
});
