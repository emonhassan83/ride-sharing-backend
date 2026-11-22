/**
 * Unit tests: `checkNoShowPassengers` cron job (riders who did not show up after the driver arrived).
 *
 * Policy: a no-show gets NO refund (the job never touches wallets or Refund documents); a card
 * authorisation still held is released. Time: now = 2026-03-20T00:00Z; waiting time default 60 min.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/app/modules/passenger/passenger.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Passenger: createModelMock() };
});
vi.mock('@src/app/modules/ride/ride.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Ride: createModelMock() };
});
vi.mock('@src/app/modules/booking/booking.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Booking: createModelMock() };
});
vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
});
vi.mock('@src/app/modules/payment/payment.service', () => ({
  PaymentService: { cancelAuthorizedBookingPayment: vi.fn() },
}));
vi.mock('@src/app/utils/notifyUser.utils', () => ({ notifyUserPush: vi.fn() }));
vi.mock('@src/app/utils/splitFare.utils', () => ({ recalculateSplitFares: vi.fn() }));
vi.mock('@src/app/socket/socket.init', () => ({ getIO: vi.fn() }));

import { checkNoShowPassengers } from '@src/app/job/noShowPassengers.job';
import { Booking } from '@src/app/modules/booking/booking.model';
import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { PaymentService } from '@src/app/modules/payment/payment.service';
import { Ride } from '@src/app/modules/ride/ride.model';
import { Setting } from '@src/app/modules/settings/settings.model';
import { getIO } from '@src/app/socket/socket.init';
import { notifyUserPush } from '@src/app/utils/notifyUser.utils';
import { recalculateSplitFares } from '@src/app/utils/splitFare.utils';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockDoc, mockQuery, oidStr } from '@tests/helpers/mongoose';
import { createMockIo, type MockIo } from '@tests/helpers/socket';
import { freezeTime } from '@tests/helpers/time';

const NOW = '2026-03-20T00:00:00Z';
const rideId = oidStr();
const driverId = oidStr();
const riderId = oidStr();

let io: MockIo;

const makeRide = (o: Record<string, any> = {}) => ({
  _id: rideId,
  type: 'private',
  driverId,
  rideCreatedBy: riderId,
  ...o,
});

const makeNoShow = (o: Record<string, any> = {}) => ({
  _id: oidStr(),
  rideId,
  userId: riderId,
  status: 'driver_arrived',
  arriveAt: new Date('2026-03-19T22:00:00Z'),
  isNoShow: false,
  pickedUpAt: null,
  requestedSeats: 1,
  malePassengers: 0,
  femalePassengers: 0,
  ...o,
});

/** Passengers returned by the cron query (`find(...).limit(50).lean()`). */
const noShowsFound = (list: any[]) => vi.mocked(Passenger.find).mockReturnValue(mockQuery(list) as any);

beforeEach(async () => {
  freezeTime(NOW);
  io = createMockIo();
  vi.mocked(getIO).mockReturnValue(io as any);
  vi.mocked(Setting.findOne).mockReturnValue(mockQuery(null) as any);
  vi.mocked(Ride.findById).mockReturnValue(mockQuery(makeRide()) as any);
  vi.mocked(Booking.findOne).mockReturnValue(mockQuery(null) as any);
  vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(0) as any);
  await fakeRedis.hset(`driver:${driverId}:details`, { bookedSeats: '3' });
});

describe('checkNoShowPassengers - selection', () => {
  it('does nothing when no passenger is a no-show', async () => {
    noShowsFound([]);
    await checkNoShowPassengers();
    expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Ride.findById).not.toHaveBeenCalled();
    expect(io.emitted).toHaveLength(0);
  });

  it('selects only passengers the driver marked arrived, not yet picked up and not already no-show, in batches of 50', async () => {
    const q = mockQuery([]);
    vi.mocked(Passenger.find).mockReturnValue(q as any);
    await checkNoShowPassengers();
    expect(Passenger.find).toHaveBeenCalledWith({
      status: 'driver_arrived',
      rideId: { $ne: null },
      arriveAt: { $lte: new Date('2026-03-19T23:00:00Z') }, // now - 60 min default
      isNoShow: { $ne: true },
      pickedUpAt: null,
    });
    expect(q.limit).toHaveBeenCalledWith(50);
  });

  it('boundary: the waiting-time cutoff is inclusive of exactly waitingTimeMinutes ago', async () => {
    vi.mocked(Setting.findOne).mockReturnValue(mockQuery({ key: 'waitingTimeMinutes', value: '15' }) as any);
    noShowsFound([]);
    await checkNoShowPassengers();
    expect(Setting.findOne).toHaveBeenCalledWith({ key: 'waitingTimeMinutes' });
    expect(Passenger.find).toHaveBeenCalledWith(
      expect.objectContaining({ arriveAt: { $lte: new Date('2026-03-19T23:45:00Z') } }),
    );
  });

  it('CHARACTERIZATION: a blank waitingTimeMinutes setting is read as 0 minutes, not the 60-minute default', async () => {
    vi.mocked(Setting.findOne).mockReturnValue(mockQuery({ key: 'waitingTimeMinutes', value: '' }) as any);
    noShowsFound([]);
    await checkNoShowPassengers();
    expect(Passenger.find).toHaveBeenCalledWith(
      expect.objectContaining({ arriveAt: { $lte: new Date(NOW) } }),
    );
  });
});

describe('checkNoShowPassengers - the no-show itself', () => {
  it('marks the passenger a no-show: cancelled, isNoShow, reason and system actor', async () => {
    const p = makeNoShow();
    noShowsFound([p]);
    await checkNoShowPassengers();
    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(p._id, {
      status: 'cancelled',
      isNoShow: true,
      cancellationReason: 'no_show',
      cancelledBy: 'system',
    });
  });

  it('releases the card authorisation for the booking', async () => {
    const p = makeNoShow();
    const booking = mockDoc({ _id: oidStr(), passengerId: String(p._id) });
    noShowsFound([p]);
    vi.mocked(Booking.findOne).mockReturnValue(mockQuery(booking) as any);
    await checkNoShowPassengers();
    expect(Booking.findOne).toHaveBeenCalledWith({ passengerId: p._id });
    expect(PaymentService.cancelAuthorizedBookingPayment).toHaveBeenCalledWith(String(booking._id));
  });

  it('no booking: the no-show is still processed, there is just no hold to release', async () => {
    const p = makeNoShow();
    noShowsFound([p]);
    vi.mocked(Booking.findOne).mockReturnValue(mockQuery(null) as any);
    await checkNoShowPassengers();
    expect(PaymentService.cancelAuthorizedBookingPayment).not.toHaveBeenCalled();
    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('NO refund: the booking is not modified and nothing is credited (no-refund policy)', async () => {
    const p = makeNoShow();
    const booking = mockDoc({ _id: oidStr(), passengerId: String(p._id), amountPaid: 25.5, bookingStatus: 'accepted', paymentStatus: 'paid' });
    noShowsFound([p]);
    vi.mocked(Booking.findOne).mockReturnValue(mockQuery(booking) as any);
    await checkNoShowPassengers();
    expect(booking.save).not.toHaveBeenCalled();
    expect(booking.bookingStatus).toBe('accepted');
    expect(booking.paymentStatus).toBe('paid');
  });

  it('tells the rider on the socket and by push that no refund will be issued', async () => {
    const p = makeNoShow();
    noShowsFound([p]);
    await checkNoShowPassengers();
    expect(io.payloadTo(`user:${riderId}`, 'ride:no-show')).toEqual({
      rideId,
      passengerId: p._id,
      message: 'You were marked as no-show. No refund will be issued.',
    });
    expect(notifyUserPush).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: riderId,
        message: 'You were marked as No-Show',
        description: 'You did not show up at the pickup location. No refund will be issued for this ride.',
        reference: rideId,
        data: { type: 'PASSENGER_NO_SHOW', rideId, passengerId: String(p._id) },
      }),
    );
  });

  it('tells the driver they may proceed on the socket and by push', async () => {
    const p = makeNoShow();
    noShowsFound([p]);
    await checkNoShowPassengers();
    expect(io.payloadTo(`driver:${driverId}`, 'ride:passenger-no-show')).toEqual({
      rideId,
      passengerId: p._id,
      message: 'Passenger no-show. You may proceed.',
    });
    expect(notifyUserPush).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: driverId,
        message: 'Passenger No-Show',
        description: 'One passenger did not show up. You may proceed with the ride.',
        data: { type: 'PASSENGER_NO_SHOW', rideId, passengerId: String(p._id) },
      }),
    );
  });

  it('a ride without an assigned driver: the rider is told but no driver is contacted', async () => {
    const p = makeNoShow();
    noShowsFound([p]);
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(makeRide({ driverId: undefined })) as any);
    await checkNoShowPassengers();
    expect(io.payloadTo(`user:${riderId}`, 'ride:no-show')).toBeDefined();
    expect(io.emittedEvents('ride:passenger-no-show')).toHaveLength(0);
  });

  it('a passenger row without a rideId is skipped entirely', async () => {
    noShowsFound([makeNoShow({ rideId: null })]);
    await checkNoShowPassengers();
    expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(io.emitted).toHaveLength(0);
  });

  it('if the ride no longer exists the passenger is still marked, but seats and notifications are skipped', async () => {
    const p = makeNoShow();
    noShowsFound([p]);
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(null) as any);
    await checkNoShowPassengers();
    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(p._id, expect.objectContaining({ isNoShow: true }));
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(io.emitted).toHaveLength(0);
  });
});

describe('checkNoShowPassengers - seats and ride lifecycle', () => {
  it.each([
    [2, -2],
    [undefined, -1],
  ])('frees the seats of the no-show (requestedSeats %s -> bookedSeats %i)', async (requestedSeats, delta) => {
    noShowsFound([makeNoShow({ requestedSeats })]);
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(2) as any);
    await checkNoShowPassengers();
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(rideId, { $inc: { bookedSeats: delta } });
  });

  it('split ride: fares are recalculated for the remaining riders', async () => {
    noShowsFound([makeNoShow()]);
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(makeRide({ type: 'split' })) as any);
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(2) as any);
    await checkNoShowPassengers();
    expect(recalculateSplitFares).toHaveBeenCalledWith(rideId, 'passenger_cancelled', io);
  });

  it('private ride: no fare recalculation', async () => {
    noShowsFound([makeNoShow()]);
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(2) as any);
    await checkNoShowPassengers();
    expect(recalculateSplitFares).not.toHaveBeenCalled();
  });

  it('two or more riders remain: the ride stays open (only the seat decrement touches it)', async () => {
    noShowsFound([makeNoShow()]);
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(2) as any);
    await checkNoShowPassengers();
    expect(Passenger.countDocuments).toHaveBeenCalledWith({
      rideId,
      status: { $nin: ['cancelled', 'rejected'] },
    });
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    expect(io.emittedEvents('ride:cancelled')).toHaveLength(0);
  });

  it('exactly one rider remains: ride cancelled with the one-passenger reason, driver told, Redis cleared', async () => {
    noShowsFound([makeNoShow()]);
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(1) as any);
    await fakeRedis.set(`ride:active:${rideId}`, '1');
    await fakeRedis.set(`ride:request:${rideId}`, '1');
    await fakeRedis.zadd('ride:matching:queue', 1, rideId);

    await checkNoShowPassengers();

    expect(Ride.findByIdAndUpdate).toHaveBeenLastCalledWith(rideId, {
      status: 'cancelled',
      cancellationReason: 'Only one passenger remaining. Ride cancelled.',
    });
    expect(io.payloadTo(`driver:${driverId}`, 'ride:cancelled')).toEqual({
      rideId,
      message: 'Only one passenger remaining. Ride cancelled.',
    });
    expect(notifyUserPush).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: driverId,
        message: 'Ride Cancelled',
        description: 'Only one passenger remaining. Ride cancelled.',
        data: { type: 'RIDE_CANCELLED_NO_SHOW', rideId },
      }),
    );
    expect(await fakeRedis.exists(`ride:active:${rideId}`)).toBe(0);
    expect(await fakeRedis.exists(`ride:request:${rideId}`)).toBe(0);
    expect(await fakeRedis.zscore('ride:matching:queue', rideId)).toBeNull();
  });

  it('no riders remain: ride cancelled with reason all_passengers_no_show', async () => {
    noShowsFound([makeNoShow()]);
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(0) as any);
    await checkNoShowPassengers();
    expect(Ride.findByIdAndUpdate).toHaveBeenLastCalledWith(rideId, {
      status: 'cancelled',
      cancellationReason: 'all_passengers_no_show',
    });
    expect(io.payloadTo(`driver:${driverId}`, 'ride:cancelled').message).toBe('All passengers no-show. Ride cancelled.');
  });

  it('a second run does not re-process a passenger already marked no-show (query excludes isNoShow)', async () => {
    noShowsFound([]); // second run: the already-marked passenger no longer matches
    await checkNoShowPassengers();
    expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(PaymentService.cancelAuthorizedBookingPayment).not.toHaveBeenCalled();
  });
});

describe('KNOWN BUGS (documented; each asserts the CORRECT behaviour and currently fails by design)', () => {
  // BUG-REPORT JOB-4 | medium | noShowPassengers.job.ts:39-49
  // The passenger is marked cancelled/no-show BEFORE the card hold is released. If the Stripe
  // release throws, the outer try/catch (line 169) only logs. The passenger is no longer
  // "driver_arrived", so the next run never retries: the hold is never released and the seat is
  // never freed. Fix: release the hold first (or only mark no-show after it succeeds) and retry.
  it.fails('BUG JOB-4: a failed hold release must not leave the passenger marked as a no-show', async () => {
    noShowsFound([makeNoShow()]);
    vi.mocked(Booking.findOne).mockReturnValue(mockQuery(mockDoc({ _id: oidStr() })) as any);
    vi.mocked(PaymentService.cancelAuthorizedBookingPayment).mockRejectedValueOnce(new Error('Stripe down'));

    await checkNoShowPassengers();

    expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  // BUG-REPORT JOB-5 | low | noShowPassengers.job.ts:43-170
  // One outer try/catch wraps the whole batch, so a throw for one no-show skips every later no-show
  // in that run (they stay driver_arrived and are only picked up one cron cycle later). The failing
  // passenger itself is already marked and is never retried (see JOB-4). Fix: per-passenger try/catch.
  it.fails('BUG JOB-5: one failing no-show must not stop the other no-shows in the batch', async () => {
    const first = makeNoShow();
    const second = makeNoShow({ userId: oidStr() });
    noShowsFound([first, second]);
    vi.mocked(Booking.findOne).mockReturnValue(mockQuery(mockDoc({ _id: oidStr() })) as any);
    vi.mocked(PaymentService.cancelAuthorizedBookingPayment).mockRejectedValueOnce(new Error('Stripe down'));

    await checkNoShowPassengers();

    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(
      second._id,
      expect.objectContaining({ isNoShow: true }),
    );
  });

  // BUG-REPORT JOB-6 | medium | noShowPassengers.job.ts:109-110
  // The no-show frees the ride seat (bookedSeats) but not the matching counters: the driver's Redis
  // bookedSeats hash and the ride's malePassengers/femalePassengers are not decremented, unlike
  // driverCancelRide and rideCancelAfterAccept. Seat counts then drift and a driver can look full.
  // Fix: mirror the cancel handlers' $inc and the driver's hincrby bookedSeats.
  it.fails('BUG JOB-6: a no-show must also release the driver Redis seat and the gender counters', async () => {
    noShowsFound([makeNoShow({ malePassengers: 1 })]);
    vi.mocked(Passenger.countDocuments).mockReturnValue(mockQuery(2) as any);

    await checkNoShowPassengers();

    expect(await fakeRedis.hget(`driver:${driverId}:details`, 'bookedSeats')).toBe('2');
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(
      rideId,
      expect.objectContaining({ $inc: expect.objectContaining({ malePassengers: -1 }) }),
    );
  });
});
