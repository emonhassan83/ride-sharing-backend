/**
 * Backend issue list of 23 Nov 2026 (QA round 4), against REAL MongoDB (replica set)
 * + Redis and the real Express app. Stripe is faked.
 *
 *  - B-01 wallet payment: atomic debit, SR reference + new balance in the response
 *  - B-04 cancellation quote (same policy as the cancel handlers)
 *  - B-08 a paid rider still waiting on an ACCEPTED split ride is listed under Pending
 *  - B-13 a rider left "pending" on a cancelled ride is listed under Cancelled
 *  - B-18 a notified (not yet accepting) driver only sees masked rider contact
 *  - Security: POST /setting/generals requires an admin
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fakeStripe = vi.hoisted(() => ({
  paymentIntents: {
    retrieve: vi.fn(),
    create: vi.fn(),
    cancel: vi.fn(async () => ({})),
    capture: vi.fn(async () => ({ status: 'succeeded' })),
  },
  customers: { create: vi.fn(async () => ({ id: 'cus_test' })) },
  ephemeralKeys: { create: vi.fn(async () => ({ secret: 'ek' })) },
  paymentMethods: { retrieve: vi.fn() },
  refunds: { create: vi.fn(async () => ({ id: 're_test', status: 'succeeded' })) },
}));
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      return fakeStripe;
    }
  },
}));

import app from '../../src/app';
import initializeSocketIO, { getIO } from '../../src/app/socket/socket.init';
import { connectRedis, getRedisClient } from '../../src/app/config/redis.config';
import { getChatPushQueue, initChatPushWorker } from '../../src/app/queues/chatPush.queue';
import { createToken } from '../../src/app/modules/auth/auth.utils';
import { User } from '../../src/app/modules/user/user.model';
import { Ride } from '../../src/app/modules/ride/ride.model';
import { Passenger } from '../../src/app/modules/passenger/passenger.model';
import { Booking } from '../../src/app/modules/booking/booking.model';
import { Payment } from '../../src/app/modules/payment/payment.model';
import { apiFor, localParts, wait } from './helpers';

const SECRET = 'it-access-secret';
const PICKUP = { lat: 35.1856, lng: 33.3823 };
const DEST = { lat: 34.6786, lng: 33.0413 };
const point = (p: { lat: number; lng: number }, address: string) => ({ address, coordinates: [p.lng, p.lat] });
const tomorrow = localParts(new Date(Date.now() + 26 * 3600_000)).date;

let server: http.Server;
let port: number;
const api = apiFor(() => port);

type TUser = { id: string; token: string; phone: string; email: string };
let seq = 0;
const makeUser = async (role: 'user' | 'provider' | 'admin', wallet = 0): Promise<TUser> => {
  seq += 1;
  const email = `r4-${role}-${seq}@example.com`;
  const phone = `+3579700${String(seq).padStart(4, '0')}`;
  const u = await User.create({
    status: 'active', isKycVerified: true, isDeleted: false, language: 'en',
    name: `R4 ${role} ${seq}`, email, phone, role, wallet,
  } as any);
  return { id: String(u._id), token: createToken({ userId: u._id, email, role }, SECRET, '1h'), phone, email };
};

const makeRideWithPassenger = async (opts: {
  rider: TUser;
  type?: 'private' | 'split';
  rideStatus?: string;
  driverId?: string;
  notifiedDriverIds?: string[];
  passengerStatus?: string;
  bookingPaymentStatus?: string;
  totalFare?: number;
}) => {
  const ride = await Ride.create({
    type: opts.type ?? 'private', rideCreatedBy: opts.rider.id, pickup: point(PICKUP, 'Nicosia'),
    destination: point(DEST, 'Limassol'), departureDate: tomorrow, departureTime: '10:00', totalSeats: 4,
    status: opts.rideStatus ?? 'pending',
    ...(opts.driverId ? { driverId: opts.driverId } : {}),
    notifiedDriverIds: opts.notifiedDriverIds ?? [],
  } as any);
  const passenger = await Passenger.create({
    userId: opts.rider.id, rideId: ride._id, pickup: point(PICKUP, 'Nicosia'), destination: point(DEST, 'Limassol'),
    departureDate: tomorrow, departureTime: '10:00', requestedSeats: 1, fareType: 'day',
    estimatedFare: opts.totalFare ?? 20, status: opts.passengerStatus ?? 'pending', paymentStatus: 'pending',
  } as any);
  const booking = await Booking.create({
    passengerId: passenger._id, userId: opts.rider.id, rideId: ride._id, totalFare: opts.totalFare ?? 20,
    amountPaid: 0, bookingStatus: 'pending', paymentStatus: opts.bookingPaymentStatus ?? 'pending',
  } as any);
  return { rideId: String(ride._id), passengerId: String(passenger._id), bookingId: String(booking._id), booking };
};

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URL as string);
  await mongoose.connection.dropDatabase();
  await Promise.all([User.syncIndexes(), Ride.syncIndexes(), Passenger.syncIndexes(), Booking.syncIndexes(), Payment.syncIndexes()]);
  await connectRedis();
  await getRedisClient().flushdb();
  server = http.createServer(app);
  initializeSocketIO(server);
  initChatPushWorker();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await wait(200);
  try {
    getIO().close();
  } catch {
    /* ignore */
  }
  await new Promise<void>((r) => server.close(() => r()));
  await initChatPushWorker().close();
  await getChatPushQueue().close();
  await getRedisClient().quit();
  await mongoose.disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B-01: pay with wallet', () => {
  it('debits the wallet once and returns the SR booking reference and the new balance', async () => {
    const rider = await makeUser('user', 410);
    const b = await makeRideWithPassenger({ rider });

    const res = await api('/payments/pay-with-wallet', {
      method: 'POST', token: rider.token, body: JSON.stringify({ booking: b.bookingId }),
    });
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.bookingShortId).toMatch(/^SR-\d{10}$/);
    expect(body.data.bookingShortId).toBe((await Booking.findById(b.bookingId).lean())?.id);
    expect(body.data.walletBalance).toBe(390);
    expect((await User.findById(rider.id).lean())?.wallet).toBe(390);
  });

  it('refuses when the balance does not cover the fare and leaves the wallet untouched', async () => {
    const rider = await makeUser('user', 5);
    const b = await makeRideWithPassenger({ rider });

    const res = await api('/payments/pay-with-wallet', {
      method: 'POST', token: rider.token, body: JSON.stringify({ booking: b.bookingId }),
    });

    expect(res.status).toBe(400);
    expect((await User.findById(rider.id).lean())?.wallet).toBe(5);
    expect(await Payment.countDocuments({ booking: b.bookingId })).toBe(0);
  });

  it('a double tap pays once (one debit, one payment)', async () => {
    const rider = await makeUser('user', 100);
    const b = await makeRideWithPassenger({ rider });
    const pay = () =>
      api('/payments/pay-with-wallet', { method: 'POST', token: rider.token, body: JSON.stringify({ booking: b.bookingId }) });

    const results = await Promise.all([pay(), pay()]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await User.findById(rider.id).lean())?.wallet).toBe(80);
    expect(await Payment.countDocuments({ booking: b.bookingId, status: 'paid' })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B-08 / B-13: rider ride lists', () => {
  it('B-08: a paid rider waiting on an already ACCEPTED split ride is under Pending', async () => {
    const rider = await makeUser('user');
    const driver = await makeUser('provider');
    const b = await makeRideWithPassenger({
      rider, type: 'split', rideStatus: 'accepted', driverId: driver.id, bookingPaymentStatus: 'authorized',
    });

    const res = await api('/ride/rider-rides?status=pending', { token: rider.token });
    const body: any = await res.json();

    expect(res.status).toBe(200);
    const row = body.data.find((r: any) => String(r.passengerId) === b.passengerId);
    expect(row).toBeDefined();
    expect(row.passengerStatus).toBe('pending');
    expect(row.rideShortId).toMatch(/^SR-/);
    expect(row.departureAt).toEqual(expect.stringMatching(/Z$/));
  });

  it('B-13: a rider left "pending" on a CANCELLED ride is under Cancelled', async () => {
    const rider = await makeUser('user');
    const b = await makeRideWithPassenger({ rider, rideStatus: 'cancelled' });

    const res = await api('/ride/rider-rides?status=cancelled', { token: rider.token });
    const body: any = await res.json();

    expect(body.data.map((r: any) => String(r.passengerId))).toContain(b.passengerId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B-18: rider contact before acceptance', () => {
  it('a notified driver sees a masked phone and no email; a stranger is refused', async () => {
    const rider = await makeUser('user');
    const notified = await makeUser('provider');
    const stranger = await makeUser('provider');
    const b = await makeRideWithPassenger({ rider, notifiedDriverIds: [notified.id] });

    const res = await api(`/passenger/ride/${b.rideId}`, { token: notified.token });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.data[0].userId.phone).not.toBe(rider.phone);
    expect(body.data[0].userId.phone).toMatch(/•/);
    expect(body.data[0].userId.email ?? null).toBeNull();

    const detail: any = await (await api(`/ride/${b.rideId}`, { token: notified.token })).json();
    expect(detail.data.passengers[0].userId.phone).toMatch(/•/);
    expect(detail.data.rideCreatedBy.email).toBeNull();

    expect((await api(`/passenger/ride/${b.rideId}`, { token: stranger.token })).status).toBe(403);
    expect((await api(`/ride/${b.rideId}`, { token: stranger.token })).status).toBe(403);
  });

  it('the assigned driver sees full contact once the passenger is accepted', async () => {
    const rider = await makeUser('user');
    const driver = await makeUser('provider');
    const b = await makeRideWithPassenger({
      rider, rideStatus: 'accepted', driverId: driver.id, passengerStatus: 'confirmed',
    });

    const body: any = await (await api(`/passenger/ride/${b.rideId}`, { token: driver.token })).json();
    expect(body.data[0].userId.phone).toBe(rider.phone);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B-04: cancellation quote', () => {
  it('before acceptance: free, full refund of what was paid', async () => {
    const rider = await makeUser('user');
    const b = await makeRideWithPassenger({ rider });
    await Booking.updateOne({ _id: b.bookingId }, { $set: { amountPaid: 20, paymentStatus: 'paid' } });

    const body: any = await (await api(`/ride/${b.rideId}/cancellation-quote`, { token: rider.token })).json();

    expect(body.data).toMatchObject({
      cancelEvent: 'ride:cancel-before-accept',
      paidAmount: 20,
      feeAmount: 0,
      feePercent: 0,
      refundAmount: 20,
      refundDestination: 'wallet',
    });
  });

  it('after acceptance, outside the restriction window: no fee', async () => {
    const rider = await makeUser('user');
    const driver = await makeUser('provider');
    const b = await makeRideWithPassenger({
      rider, rideStatus: 'accepted', driverId: driver.id, passengerStatus: 'confirmed',
    });
    await Booking.updateOne({ _id: b.bookingId }, { $set: { amountPaid: 20, paymentStatus: 'paid' } });

    const body: any = await (await api(`/ride/${b.rideId}/cancellation-quote`, { token: rider.token })).json();

    expect(body.data).toMatchObject({
      cancelEvent: 'ride:cancel-after-accept',
      feeAmount: 0,
      refundAmount: 20,
      refundReason: 'outside_refund_restriction_window',
    });
    expect(body.data.freeCancellationUntil).toEqual(expect.stringMatching(/Z$/));
  });

  it('an admin-set 20% cancellation fee shows in the quote, and 0% restores the default', async () => {
    const admin = await makeUser('admin');
    const rider = await makeUser('user');
    const driver = await makeUser('provider');
    const b = await makeRideWithPassenger({
      rider, rideStatus: 'accepted', driverId: driver.id, passengerStatus: 'confirmed',
    });
    await Booking.updateOne({ _id: b.bookingId }, { $set: { amountPaid: 20, paymentStatus: 'paid' } });

    const set = (value: number) =>
      api('/setting/generals', {
        method: 'POST', token: admin.token, body: JSON.stringify({ cancellationFeePercent: value }),
      });
    // Out-of-range values are rejected by validation.
    expect((await set(150)).status).toBe(400);

    expect((await set(20)).status).toBe(200);
    const quoted: any = await (await api(`/ride/${b.rideId}/cancellation-quote`, { token: rider.token })).json();
    expect(quoted.data).toMatchObject({
      feeAmount: 4, feePercent: 20, refundAmount: 16, earlyFeePercent: 20, freeCancellationUntil: null,
    });

    expect((await set(0)).status).toBe(200);
    const free: any = await (await api(`/ride/${b.rideId}/cancellation-quote`, { token: rider.token })).json();
    expect(free.data).toMatchObject({ feeAmount: 0, refundAmount: 20, earlyFeePercent: 0 });
  });

  it('another rider cannot get a quote for my booking', async () => {
    const rider = await makeUser('user');
    const other = await makeUser('user');
    const b = await makeRideWithPassenger({ rider });

    expect((await api(`/ride/${b.rideId}/cancellation-quote`, { token: other.token })).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Security: general settings', () => {
  it('POST /setting/generals requires an admin', async () => {
    const rider = await makeUser('user');
    expect((await api('/setting/generals', { method: 'POST', body: JSON.stringify({ baseFare: 1 }) })).status).toBe(401);
    expect(
      (await api('/setting/generals', { method: 'POST', token: rider.token, body: JSON.stringify({ baseFare: 1 }) })).status,
    ).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Refund approval push (empty title used to roll back the wallet credit)', () => {
  it('admin approves a refund for a rider WITH an FCM token: wallet credited, titled push saved', async () => {
    const { Refund } = await import('../../src/app/modules/refund/refund.model');
    const { Notification } = await import('../../src/app/modules/notification/notification.model');
    const admin = await makeUser('admin');
    const rider = await makeUser('user', 5);
    await User.updateOne({ _id: rider.id }, { $set: { fcmToken: `fcm-r4-refund-${rider.id}` } });
    const refund = await Refund.create({
      user: rider.id, amount: 20, reason: 'Ride issue', note: 'Requested by rider', status: 'pending',
    } as any);

    const res = await api(`/refunds/status/${refund._id}`, {
      method: 'PATCH', token: admin.token, body: JSON.stringify({ status: 'confirmed' }),
    });

    expect(res.status).toBe(200);
    expect((await User.findById(rider.id).lean())?.wallet).toBe(25);
    expect((await Refund.findById(refund._id).lean())?.status).toBe('confirmed');
    const note: any = await Notification.findOne({ receiver: rider.id, modelType: 'Refund' } as any).lean();
    expect(note?.message).toBe('Refund Approved');
    expect(note?.type).toBe('REFUND_ISSUED');
  });
});

describe('Refund status endpoint returns real status codes (not 500 for everything)', () => {
  const setup = async () => {
    const { Refund } = await import('../../src/app/modules/refund/refund.model');
    const admin = await makeUser('admin');
    const rider = await makeUser('user', 0);
    const refund = await Refund.create({
      user: rider.id, amount: 10, reason: 'Ride issue', note: 'Requested', status: 'pending',
    } as any);
    const approve = () =>
      api(`/refunds/status/${refund._id}`, {
        method: 'PATCH', token: admin.token, body: JSON.stringify({ status: 'confirmed' }),
      });
    return { admin, rider, approve };
  };

  it('approving an already processed refund → 409 with a translated message, wallet credited once', async () => {
    const { rider, approve } = await setup();
    expect((await approve()).status).toBe(200);

    const again = await approve();
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).message).toBe('This refund request has already been processed.');
    expect((await User.findById(rider.id).lean())?.wallet).toBe(10);
  });

  it('unknown refund id → 404, not 500', async () => {
    const admin = await makeUser('admin');
    const res = await api(`/refunds/status/${new mongoose.Types.ObjectId()}`, {
      method: 'PATCH', token: admin.token, body: JSON.stringify({ status: 'rejected' }),
    });
    expect(res.status).toBe(404);
  });

  it('two simultaneous approvals: exactly one succeeds, the other gets 409, wallet credited once', async () => {
    const { rider, approve } = await setup();
    const statuses = (await Promise.all([approve(), approve()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect((await User.findById(rider.id).lean())?.wallet).toBe(10);
  });
});
