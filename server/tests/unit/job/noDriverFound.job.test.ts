/**
 * Unit tests: `checkNoDriverFound` cron job (re-notify drivers before pickup; cancel + refund rides
 * nobody accepted once pickup time has passed).
 *
 * Time: now = 2026-03-20T00:00Z. Nicosia is UTC+2 in March, so local "04:00" on the 20th is 02:00Z.
 * Money: euro decimals (2dp). Stripe: the job's module-level client is the shared mock instance.
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
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
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
vi.mock('@src/app/utils/notifyUser.utils', () => ({ notifyUserPush: vi.fn() }));
vi.mock('@src/app/utils/notifyDrivers.utils', () => ({
  notifyNearbyDrivers: vi.fn(),
  notifyRiderDriversNotified: vi.fn(),
}));
vi.mock('@src/app/utils/splitFare.utils', () => ({ refundToWallet: vi.fn() }));
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));

import Stripe from 'stripe';
import { checkNoDriverFound } from '@src/app/job/noDriverFound.job';
import { Booking } from '@src/app/modules/booking/booking.model';
import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { Payment } from '@src/app/modules/payment/payment.model';
import { Refund } from '@src/app/modules/refund/refund.model';
import { Ride } from '@src/app/modules/ride/ride.model';
import { Setting } from '@src/app/modules/settings/settings.model';
import { User } from '@src/app/modules/user/user.model';
import { getIO } from '@src/app/socket/socket.init';
import { notifyNearbyDrivers, notifyRiderDriversNotified } from '@src/app/utils/notifyDrivers.utils';
import { notifyUserPush } from '@src/app/utils/notifyUser.utils';
import { refundToWallet } from '@src/app/utils/splitFare.utils';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockDoc, mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, type MockIo } from '@tests/helpers/socket';
import type { StripeMock } from '@tests/helpers/stripeMock';
import { freezeTime } from '@tests/helpers/time';

const NOW = '2026-03-20T00:00:00Z';
const rideId = oidStr();
const riderId = oidStr();
const passengerId = oidStr();
const bookingId = oidStr();
const d1 = oidStr();
const d2 = oidStr();

let io: MockIo;
let stripe: StripeMock;

/** Pending ride. departureDate/departureTime are Nicosia wall-clock. */
const makeRide = (o: Record<string, any> = {}) => ({
  _id: rideId,
  type: 'private',
  status: 'pending',
  departureDate: '2026-03-20',
  departureTime: '04:00', // 02:00Z -> +2h
  createdAt: new Date('2026-03-18T00:00:00Z'),
  pickup: { address: 'Pickup St', coordinates: [33.36, 35.17] },
  destination: { address: 'Dest Ave', coordinates: [33.4, 35.2] },
  rideCreatedBy: riderId,
  notifiedDriverIds: [d1, d2],
  ...o,
});

const withDeparture = (date: string, time: string, o: Record<string, any> = {}) =>
  makeRide({ departureDate: date, departureTime: time, ...o });

const makePassenger = (o: Record<string, any> = {}) => ({
  _id: passengerId,
  rideId,
  userId: riderId,
  status: 'pending',
  requestedSeats: 2,
  estimatedFare: 25,
  estimatedDistanceKm: 8,
  estimatedDurationMinutes: 20,
  createdAt: new Date('2026-03-18T00:00:00Z'),
  ...o,
});

const paidBooking = (o: Record<string, any> = {}) =>
  mockDoc({
    _id: bookingId,
    passengerId,
    rideId,
    userId: riderId,
    bookingStatus: 'accepted',
    paymentStatus: 'paid',
    amountPaid: 25.5,
    transactionId: 'pi_booking',
    ...o,
  });

/** The Ride.find calls in order: (1) pending rides, (2) rides past pickup to re-check. */
const queueRideFinds = (pending: any[], truly: any[] = []) => {
  vi.mocked(Ride.find)
    .mockReturnValueOnce(mockQuery(pending) as any)
    .mockReturnValueOnce(mockQuery(truly) as any);
};

beforeEach(async () => {
  freezeTime(NOW);
  io = createMockIo();
  vi.mocked(getIO).mockReturnValue(io as any);
  const instance = new (Stripe as any)() as StripeMock;
  stripe = instance;
  vi.mocked(User.findById).mockReturnValue(mockQuery({ _id: riderId, name: 'Ann', profileImage: null }) as any);
  vi.mocked(Setting.find).mockReturnValue(mockQuery([]) as any);
  await fakeRedis.hset(`ride:request:${rideId}`, { matchingStatus: 'x' });
});

// ────────────────────────────────────────────────────────────────────────────
describe('checkNoDriverFound - re-notify drivers before pickup', () => {
  it('queries pending, unassigned rides departing within the 48h horizon, in batches of 50', async () => {
    const q = mockQuery([]);
    vi.mocked(Ride.find).mockReturnValueOnce(q as any);
    await checkNoDriverFound();
    expect(Ride.find).toHaveBeenCalledWith({
      status: 'pending',
      $or: [{ driverId: { $exists: false } }, { driverId: null }],
      departureDate: { $lte: '2026-03-22' },
      createdAt: { $lte: new Date('2026-03-19T23:59:30Z') },
    });
    expect(q.limit).toHaveBeenCalledWith(50);
  });

  it('boundary: a ride departing 50h away (beyond the 48h horizon) is not touched', async () => {
    queueRideFinds([withDeparture('2026-03-22', '04:00')]); // 02:00Z on the 22nd = +50h
    await checkNoDriverFound();
    expect(notifyNearbyDrivers).not.toHaveBeenCalled();
    expect(Passenger.findOne).not.toHaveBeenCalled();
  });

  it('boundary: a ride departing exactly 48h away IS re-notified (initial window)', async () => {
    queueRideFinds([withDeparture('2026-03-22', '02:00')]); // 00:00Z on the 22nd = +48h
    vi.mocked(Passenger.findOne).mockReturnValue(mockQuery(makePassenger()) as any);
    vi.mocked(Booking.findOne).mockReturnValue(mockQuery(paidBooking()) as any);
    vi.mocked(notifyNearbyDrivers).mockResolvedValue(2);
    await checkNoDriverFound();
    expect(notifyNearbyDrivers).toHaveBeenCalledTimes(1);
  });

  it('boundary: exactly 24h away is in the FINAL window (re-notified even if initially re-notified)', async () => {
    queueRideFinds([withDeparture('2026-03-21', '02:00', { reNotifiedAt: new Date(NOW) })]); // +24h
    vi.mocked(Passenger.findOne).mockReturnValue(mockQuery(makePassenger()) as any);
    vi.mocked(Booking.findOne).mockReturnValue(mockQuery(paidBooking()) as any);
    vi.mocked(notifyNearbyDrivers).mockResolvedValue(1);
    await checkNoDriverFound();
    expect(notifyNearbyDrivers).toHaveBeenCalledTimes(1);
    expect(await fakeRedis.hget(`ride:request:${rideId}`, 'matchingStatus')).toBe('continuous_renotified');
  });

  it('initial window: a ride already re-notified once is skipped until the final window', async () => {
    queueRideFinds([withDeparture('2026-03-21', '04:00', { reNotifiedAt: new Date(NOW) })]); // +26h
    await checkNoDriverFound();
    expect(notifyNearbyDrivers).not.toHaveBeenCalled();
    expect(Passenger.findOne).not.toHaveBeenCalled();
  });

  it('throttle: a ride checked within the renotify interval is skipped', async () => {
    queueRideFinds([makeRide()]);
    await fakeRedis.set(`ride:matching:renotify:${rideId}`, '1', 'EX', 600);
    await checkNoDriverFound();
    expect(Passenger.findOne).not.toHaveBeenCalled();
    expect(notifyNearbyDrivers).not.toHaveBeenCalled();
  });

  it('a ride with no pending passenger is skipped', async () => {
    queueRideFinds([makeRide()]);
    vi.mocked(Passenger.findOne).mockReturnValue(mockQuery(null) as any);
    await checkNoDriverFound();
    expect(Booking.findOne).not.toHaveBeenCalled();
    expect(notifyNearbyDrivers).not.toHaveBeenCalled();
  });

  it('no paid or authorised booking: only marks the request "awaiting_payment", no drivers are notified', async () => {
    queueRideFinds([makeRide()]);
    vi.mocked(Passenger.findOne).mockReturnValue(mockQuery(makePassenger()) as any);
    vi.mocked(Booking.findOne).mockReturnValue(mockQuery(null) as any);
    await checkNoDriverFound();
    expect(notifyNearbyDrivers).not.toHaveBeenCalled();
    expect(await fakeRedis.hget(`ride:request:${rideId}`, 'matchingStatus')).toBe('awaiting_payment');
    expect(await fakeRedis.hget(`ride:request:${rideId}`, 'lastCheckedAt')).toBe(String(new Date(NOW).getTime()));
  });

  it('notifies nearby drivers with the passenger payload, throttles the ride and records matching state', async () => {
    queueRideFinds([makeRide()]);
    vi.mocked(Passenger.findOne).mockReturnValue(mockQuery(makePassenger()) as any);
    vi.mocked(Booking.findOne).mockReturnValue(mockQuery(paidBooking()) as any);
    vi.mocked(notifyNearbyDrivers).mockResolvedValue(2);

    await checkNoDriverFound();

    expect(notifyNearbyDrivers).toHaveBeenCalledWith(
      rideId,
      { lat: 35.17, lng: 33.36 },
      expect.objectContaining({
        _id: passengerId,
        userId: expect.objectContaining({ _id: riderId, name: 'Ann' }),
        rideType: 'private',
        bookingId,
        requestedSeats: 2,
        estimatedFare: 25,
        status: 'pending',
      }),
      fakeRedis,
      io,
      passengerId,
      10,
    );
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(rideId, { reNotifiedAt: new Date(NOW) });
    // throttle key expires after renotify interval (10 min default)
    expect(await fakeRedis.ttl(`ride:matching:renotify:${rideId}`)).toBe(600);
    expect(await fakeRedis.hgetall(`ride:request:${rideId}`)).toMatchObject({
      bookingId,
      notifiedCount: '2',
      matchingStatus: 'continuous_renotified', // default ride is 2h out = final window
      lastNotifiedAt: String(new Date(NOW).getTime()),
    });
  });

  it.each([
    ['initial', 26, 'renotify_no_driver', 0],
    ['final', 2, 'continuous_matching_no_new_driver', 0],
  ])('no new driver found in the %s window -> matchingStatus %s', async (_stage, hours, status, notified) => {
    const date = hours === 26 ? '2026-03-21' : '2026-03-20';
    const time = hours === 26 ? '04:00' : '04:00';
    queueRideFinds([withDeparture(date, time, { reNotifiedAt: undefined })]);
    vi.mocked(Passenger.findOne).mockReturnValue(mockQuery(makePassenger()) as any);
    vi.mocked(Booking.findOne).mockReturnValue(mockQuery(paidBooking()) as any);
    vi.mocked(notifyNearbyDrivers).mockResolvedValue(notified);
    await checkNoDriverFound();
    expect(await fakeRedis.hget(`ride:request:${rideId}`, 'matchingStatus')).toBe(status);
  });

  it.each([1, 5])(
    'tells every waiting rider how many drivers were notified (total %i): rematch variant + legacy event',
    async (total) => {
      queueRideFinds([makeRide()]);
      const r1 = oidStr();
      const r2 = oidStr();
      vi.mocked(Passenger.findOne).mockReturnValue(mockQuery(makePassenger()) as any);
      vi.mocked(Booking.findOne).mockReturnValue(mockQuery(paidBooking()) as any);
      vi.mocked(notifyNearbyDrivers).mockResolvedValue(0);
      vi.mocked(Passenger.find).mockReturnValue(
        mockQuery([
          { _id: oidStr(), userId: r1 },
          { _id: oidStr(), userId: r2 },
        ]) as any,
      );
      vi.mocked(notifyRiderDriversNotified).mockResolvedValue(total);

      await checkNoDriverFound();

      expect(notifyRiderDriversNotified).toHaveBeenCalledWith(
        expect.objectContaining({ io, userId: r1, rideId, newlyNotified: 0, variant: 'rematch', rematchStage: 'final' }),
      );
      const word = total === 1 ? 'driver' : 'drivers';
      expect(io.payloadTo(`user:${r2}`, 'ride:re-matching')).toEqual({
        rideId,
        notifiedDrivers: total,
        message: `We're still looking for a driver. ${total} ${word} notified.`,
      });
    },
  );

  it('a waiting rider without a user id is skipped', async () => {
    queueRideFinds([makeRide()]);
    vi.mocked(Passenger.findOne).mockReturnValue(mockQuery(makePassenger()) as any);
    vi.mocked(Booking.findOne).mockReturnValue(mockQuery(paidBooking()) as any);
    vi.mocked(notifyNearbyDrivers).mockResolvedValue(1);
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([{ _id: oidStr(), userId: null }]) as any);
    await checkNoDriverFound();
    expect(notifyRiderDriversNotified).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('checkNoDriverFound - cancel rides whose pickup time has passed', () => {
  // departure 01:00 Nicosia = 23:00Z on the 19th -> -1h (passed)
  const passedRide = (o: Record<string, any> = {}) => withDeparture('2026-03-20', '01:00', o);

  /** Wire the cancel path for one ride with a list of bookings + their payments. */
  const wireCancel = (
    ride: any,
    bookings: any[],
    payments: Record<string, any> = {},
    passengersToNotify: any[] = [{ userId: riderId, rideId }],
    confirmed: string[] = [],
  ) => {
    queueRideFinds([ride], [{ _id: rideId }]);
    vi.mocked(Passenger.distinct).mockReturnValue(mockQuery(confirmed) as any);
    vi.mocked(Ride.findOneAndUpdate).mockImplementation(((filter: any) =>
      mockQuery({ _id: filter._id })) as any);
    vi.mocked(Booking.find).mockReturnValue(mockQuery(bookings) as any);
    vi.mocked(Payment.findOne).mockImplementation(((filter: any) =>
      mockQuery(payments[String(filter.booking)] ?? null)) as any);
    vi.mocked(Passenger.find).mockReturnValue(mockQuery(passengersToNotify) as any);
  };

  it('a passed ride is cancelled: booking refunded, payment refunded, Refund created, wallet credited, riders & drivers told', async () => {
    const ride = passedRide();
    const booking = paidBooking();
    const payment = mockDoc({ _id: oidStr(), booking: bookingId, status: 'paid', isPaid: true, transactionId: 'txn_1' });
    wireCancel(ride, [booking], { [bookingId]: payment });

    await checkNoDriverFound();

    // ride claimed atomically
    expect(Ride.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: rideId, status: 'pending' }),
      expect.objectContaining({ status: 'cancelled', cancellationReason: 'no_driver_found', cancelledBy: 'system' }),
      { projection: { _id: 1 } },
    );

    // refund checklist
    expect(refundToWallet).toHaveBeenCalledWith(riderId, 25.5, 'no_driver_found', io);
    expect(booking.bookingStatus).toBe('cancelled');
    expect(booking.paymentStatus).toBe('refunded');
    expect(booking.refundAmount).toBe(25.5);
    expect(booking.save).toHaveBeenCalledTimes(1);
    expect(payment.status).toBe('refunded');
    expect(payment.isPaid).toBe(false);
    expect(Refund.create).toHaveBeenCalledWith({
      user: riderId,
      ride: rideId,
      type: 'cancel_ride',
      paymentIntentId: 'pi_booking',
      amount: 25.5,
      reason: 'No driver found',
      note: `Ride ${rideId} cancelled due to no driver found`,
      status: 'confirmed',
    });
    // no driver was ever assigned, so there is no driver wallet to claw back from
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();

    // passengers and their notifications
    expect(Passenger.updateMany).toHaveBeenCalledWith(
      { rideId: { $in: [rideId] }, status: { $nin: ['cancelled', 'completed'] } },
      { status: 'cancelled', cancellationReason: 'no_driver_found', cancelledBy: 'system' },
    );
    expect(io.payloadTo(`user:${riderId}`, 'ride:no-driver-found')).toEqual({
      rideId,
      message: 'No driver accepted your ride before pickup time. Your booking has been cancelled.',
      retryAfter: 5,
    });
    expect(notifyUserPush).toHaveBeenCalledWith({
      userId: riderId,
      message: 'Ride Cancelled — No Driver Found',
      description: 'No driver accepted your ride before pickup time. Your booking has been cancelled.',
      reference: rideId,
      modelType: expect.anything(),
      dedupeKey: `no-driver-cancelled:${rideId}`,
      data: { type: 'RIDE_CANCELLED_NO_DRIVER', rideId },
    });
    for (const d of [d1, d2]) {
      expect(io.payloadTo(`driver:${d}`, 'ride:request-removed')).toEqual({
        rideId,
        reason: 'pickup_time_no_accept',
        message: 'Ride request expired. Pickup time passed with no driver accepted.',
      });
    }

    // matching state cleared
    expect(await fakeRedis.zscore('ride:matching:queue', rideId)).toBeNull();
    expect(await fakeRedis.exists(`ride:request:${rideId}`)).toBe(0);
    expect(await fakeRedis.exists(`ride:matching:renotify:${rideId}`)).toBe(0);
  });

  it('boundary: a ride whose pickup is exactly now (0h) is cancelled', async () => {
    // departure 02:00 Nicosia = 00:00Z = now
    wireCancel(withDeparture('2026-03-20', '02:00'), [paidBooking()]);
    await checkNoDriverFound();
    expect(Ride.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(refundToWallet).toHaveBeenCalledWith(riderId, 25.5, 'no_driver_found', io);
  });

  it('a ride with a confirmed passenger is NOT cancelled', async () => {
    wireCancel(passedRide(), [paidBooking()], {}, [], [rideId]);
    await checkNoDriverFound();
    expect(Ride.findOneAndUpdate).not.toHaveBeenCalled();
    expect(refundToWallet).not.toHaveBeenCalled();
    expect(Passenger.updateMany).not.toHaveBeenCalled();
  });

  it('a ride already claimed by another run (claim returns nothing) is not refunded or notified again', async () => {
    wireCancel(passedRide(), [paidBooking()]);
    vi.mocked(Ride.findOneAndUpdate).mockReturnValue(mockQuery(null) as any);
    await checkNoDriverFound();
    expect(Booking.find).not.toHaveBeenCalled();
    expect(refundToWallet).not.toHaveBeenCalled();
    expect(notifyUserPush).not.toHaveBeenCalled();
    expect(Passenger.updateMany).not.toHaveBeenCalled();
  });

  it('only bookings that are neither cancelled nor completed are loaded for refund', async () => {
    wireCancel(passedRide(), []);
    await checkNoDriverFound();
    expect(Booking.find).toHaveBeenCalledWith({
      rideId: { $in: [rideId] },
      bookingStatus: { $nin: ['cancelled', 'completed'] },
    });
    expect(refundToWallet).not.toHaveBeenCalled();
  });

  it('an unpaid booking (amountPaid 0) is cancelled but nothing is refunded', async () => {
    const booking = paidBooking({ amountPaid: 0, paymentStatus: 'pending' });
    wireCancel(passedRide(), [booking], {});
    await checkNoDriverFound();
    expect(booking.bookingStatus).toBe('cancelled');
    expect(booking.save).toHaveBeenCalledTimes(1);
    expect(Refund.create).not.toHaveBeenCalled();
    expect(refundToWallet).not.toHaveBeenCalled();
  });

  it('a booking that is still only authorised: the card hold is released via Stripe, no refund or wallet credit', async () => {
    const booking = paidBooking({ amountPaid: 0, paymentStatus: 'authorized' });
    const payment = mockDoc({ _id: oidStr(), booking: bookingId, status: 'authorized', paymentIntentId: 'pi_auth', isPaid: false });
    wireCancel(passedRide(), [booking], { [bookingId]: payment });
    stripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_capture' });

    await checkNoDriverFound();

    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_auth');
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_auth');
    expect(payment.status).toBe('cancelled_authorization');
    expect(payment.isPaid).toBe(false);
    expect(payment.save).toHaveBeenCalledTimes(1);
    expect(booking.bookingStatus).toBe('cancelled');
    expect(booking.paymentStatus).toBe('cancelled_authorization');
    expect(booking.amountPaid).toBe(0);
    expect(refundToWallet).not.toHaveBeenCalled();
    expect(Refund.create).not.toHaveBeenCalled();
  });

  it('an authorisation Stripe already reports as not capturable is not cancelled twice', async () => {
    const booking = paidBooking({ amountPaid: 0, paymentStatus: 'authorized' });
    const payment = mockDoc({ _id: oidStr(), booking: bookingId, status: 'authorized', paymentIntentId: 'pi_auth', isPaid: false });
    wireCancel(passedRide(), [booking], { [bookingId]: payment });
    stripe.paymentIntents.retrieve.mockResolvedValue({ status: 'canceled' });

    await checkNoDriverFound();

    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(payment.status).toBe('cancelled_authorization');
  });

  it('a ride with no driver notified gets no "request removed" emits, but riders are still told', async () => {
    wireCancel(passedRide({ notifiedDriverIds: [] }), [paidBooking({ amountPaid: 0 })]);
    await checkNoDriverFound();
    expect(io.emittedEvents('ride:request-removed')).toHaveLength(0);
    expect(io.payloadTo(`user:${riderId}`, 'ride:no-driver-found')).toBeDefined();
  });

  it('a cancelled passenger without a user id is skipped for notifications', async () => {
    wireCancel(passedRide(), [paidBooking({ amountPaid: 0 })], {}, [{ userId: null, rideId }]);
    await checkNoDriverFound();
    expect(notifyUserPush).not.toHaveBeenCalled();
    expect(io.emittedEvents('ride:no-driver-found')).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('KNOWN BUGS (documented; each asserts the CORRECT behaviour and currently fails by design)', () => {
  const wireTwoBookingsOneRide = () => {
    const passedRide = withDeparture('2026-03-20', '01:00');
    queueRideFinds([passedRide], [{ _id: rideId }]);
    vi.mocked(Passenger.distinct).mockReturnValue(mockQuery([]) as any);
    vi.mocked(Ride.findOneAndUpdate).mockImplementation(((filter: any) => mockQuery({ _id: filter._id })) as any);
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([]) as any);
  };

  // BUG-REPORT JOB-1 | high | noDriverFound.job.ts:331-333
  // The booking is saved as cancelled/refunded BEFORE the wallet credit. If refundToWallet throws,
  // the booking is cancelled, so the next run never finds it again (bookingStatus $nin cancelled),
  // and the ride is already cancelled, so nothing retries. The rider loses the refund and the
  // Refund document still says "confirmed". Fix: credit the wallet first, or leave the booking
  // retryable until the credit succeeds.
  it.fails('BUG JOB-1: a failed wallet credit must not leave the booking finalised as refunded', async () => {
    wireTwoBookingsOneRide();
    const booking = paidBooking();
    const payment = mockDoc({ _id: oidStr(), booking: bookingId, status: 'paid', isPaid: true });
    vi.mocked(Booking.find).mockReturnValue(mockQuery([booking]) as any);
    vi.mocked(Payment.findOne).mockReturnValue(mockQuery(payment) as any);
    vi.mocked(refundToWallet).mockRejectedValueOnce(new Error('wallet down'));

    await checkNoDriverFound().catch(() => undefined);

    expect(booking.bookingStatus).not.toBe('cancelled');
  });

  // BUG-REPORT JOB-2 | medium | noDriverFound.job.ts:286-296
  // A Stripe failure while cancelling the authorisation is only logged; the code then marks the
  // payment and booking as released (cancelled_authorization). The rider's card may still be held
  // while the system reports it released. Fix: only mark released when the intent is confirmed
  // cancelled (or retry), and surface the failure. Note: payment.service cancelAuthorizedBookingPayment
  // has the same swallow-then-mark pattern (payment.service.ts:993-1002).
  it.fails('BUG JOB-2: a failed Stripe cancel must not mark the authorisation as released', async () => {
    const booking = paidBooking({ amountPaid: 0, paymentStatus: 'authorized' });
    const payment = mockDoc({ _id: oidStr(), booking: bookingId, status: 'authorized', paymentIntentId: 'pi_auth', isPaid: false });
    wireTwoBookingsOneRide();
    vi.mocked(Booking.find).mockReturnValue(mockQuery([booking]) as any);
    vi.mocked(Payment.findOne).mockReturnValue(mockQuery(payment) as any);
    stripe.paymentIntents.retrieve.mockResolvedValue({ status: 'requires_capture' });
    stripe.paymentIntents.cancel.mockRejectedValueOnce(new Error('Stripe unavailable'));

    await checkNoDriverFound();

    expect(payment.status).not.toBe('cancelled_authorization');
  });

  // BUG-REPORT JOB-3 | high | noDriverFound.job.ts:279-341
  // The refund loop has no per-booking error handling, and the ride was already flipped to cancelled
  // (line 255). One booking's failure (e.g. Refund.create throws) aborts the batch, and the other
  // riders are never refunded: their rides are no longer pending, so no later run picks them up.
  // Fix: wrap each booking in try/catch and continue, or retry failed bookings.
  it.fails('BUG JOB-3: one failing booking must not stop the other riders of the cancelled ride from being refunded', async () => {
    const rider2 = oidStr();
    const b1 = paidBooking();
    const b2 = paidBooking({ _id: oidStr(), userId: rider2, amountPaid: 10, transactionId: 'pi_b2' });
    const p1 = mockDoc({ _id: oidStr(), booking: String(b1._id), status: 'paid', isPaid: true });
    const p2 = mockDoc({ _id: oidStr(), booking: String(b2._id), status: 'paid', isPaid: true });
    wireTwoBookingsOneRide();
    vi.mocked(Booking.find).mockReturnValue(mockQuery([b1, b2]) as any);
    vi.mocked(Payment.findOne).mockImplementation(((filter: any) =>
      mockQuery(String(filter.booking) === String(b1._id) ? p1 : p2)) as any);
    vi.mocked(Refund.create).mockRejectedValueOnce(new Error('db hiccup'));

    await checkNoDriverFound().catch(() => undefined);

    expect(refundToWallet).toHaveBeenCalledWith(rider2, 10, 'no_driver_found', io);
  });
});
