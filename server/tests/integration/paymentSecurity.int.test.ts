/**
 * Payment endpoint security (found during client QA round 3), against REAL MongoDB
 * (replica set) + Redis and the real Express app. Stripe is faked so we can see
 * exactly when the server asks Stripe for a refund.
 *
 * Before:
 *  - POST /payments/confirm-payment had no auth and refunded the Stripe intent on ANY
 *    error: a rider could post their own captured intent id with a bogus paymentId
 *    and get the fare refunded while the ride stayed "paid".
 *  - PATCH /payments/refund-payment had no auth and could refund the card again after
 *    a wallet refund.
 *  - GET /payments/:id (any logged-in user) and GET /payments/booking/:id (no login)
 *    exposed other riders' payments.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const tomorrow = localParts(new Date(Date.now() + 26 * 3600_000)).date;

let server: http.Server;
let port: number;
const api = apiFor(() => port);

type TUser = { id: string; token: string };
let seq = 0;
const makeUser = async (role: 'user' | 'provider' | 'admin'): Promise<TUser> => {
  seq += 1;
  const email = `pay-${role}-${seq}@example.com`;
  const u = await User.create({
    status: 'active', isKycVerified: true, isDeleted: false, language: 'en',
    name: `Pay ${role} ${seq}`, email, phone: `+3579800${String(seq).padStart(4, '0')}`, role, wallet: 0,
  } as any);
  return { id: String(u._id), token: createToken({ userId: u._id, email, role }, SECRET, '1h') };
};

/** A booking with one payment record; returns ids. */
const makeBookingWithPayment = async (opts: {
  rider: TUser;
  driver?: TUser;
  bookingStatus?: string;
  bookingPaymentStatus?: string;
  payment: Record<string, any>;
}) => {
  const ride = await Ride.create({
    type: 'private', rideCreatedBy: opts.rider.id, pickup: point(PICKUP, 'Nicosia'),
    destination: point(DEST, 'Limassol'), departureDate: tomorrow, departureTime: '10:00',
    totalSeats: 4, status: opts.driver ? 'accepted' : 'pending', ...(opts.driver ? { driverId: opts.driver.id } : {}),
  } as any);
  const passenger = await Passenger.create({
    userId: opts.rider.id, rideId: ride._id, pickup: point(PICKUP, 'Nicosia'), destination: point(DEST, 'Limassol'),
    departureDate: tomorrow, departureTime: '10:00', requestedSeats: 1, fareType: 'day', estimatedFare: 20,
    status: opts.driver ? 'confirmed' : 'pending', paymentStatus: 'pending',
  } as any);
  const booking = await Booking.create({
    passengerId: passenger._id, userId: opts.rider.id, rideId: ride._id,
    ...(opts.driver ? { driverId: opts.driver.id } : {}),
    totalFare: 20, amountPaid: 0,
    bookingStatus: opts.bookingStatus ?? 'pending', paymentStatus: opts.bookingPaymentStatus ?? 'pending',
  } as any);
  const res = await Payment.collection.insertOne({
    id: `PAY-${new mongoose.Types.ObjectId()}`,
    user: oid(opts.rider.id),
    provider: opts.driver ? oid(opts.driver.id) : null,
    booking: booking._id,
    method: 'card',
    transactionId: `tx-${new mongoose.Types.ObjectId()}`,
    amount: 20,
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...opts.payment,
  });
  return { rideId: String(ride._id), bookingId: String(booking._id), paymentId: String(res.insertedId) };
};

const intent = (id: string, status: string, paymentId: string) => ({
  id, status, amount: 2000, metadata: { paymentId },
});

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

beforeEach(() => {
  fakeStripe.refunds.create.mockClear();
  fakeStripe.paymentIntents.retrieve.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /payments/confirm-payment', () => {
  it('requires login', async () => {
    const res = await api('/payments/confirm-payment', {
      method: 'POST', body: JSON.stringify({ paymentIntentId: 'pi_x', paymentId: new mongoose.Types.ObjectId().toString() }),
    });
    expect(res.status).toBe(401);
    expect(fakeStripe.refunds.create).not.toHaveBeenCalled();
  });

  it('EXPLOIT: own captured intent + bogus paymentId does NOT refund the fare', async () => {
    const rider = await makeUser('user');
    const driver = await makeUser('provider');
    const b = await makeBookingWithPayment({
      rider, driver, bookingStatus: 'accepted', bookingPaymentStatus: 'paid',
      payment: { status: 'paid', isPaid: true, paymentIntentId: 'pi_captured' },
    });
    fakeStripe.paymentIntents.retrieve.mockResolvedValue(intent('pi_captured', 'succeeded', b.paymentId));

    const res = await api('/payments/confirm-payment', {
      method: 'POST', token: rider.token,
      body: JSON.stringify({ paymentIntentId: 'pi_captured', paymentId: new mongoose.Types.ObjectId().toString() }),
    });

    expect(res.status).toBe(404);
    expect(fakeStripe.refunds.create).not.toHaveBeenCalled();
    expect((await Payment.findById(b.paymentId).lean())?.status).toBe('paid');
  });

  it('an intent that belongs to another payment is refused, nothing refunded', async () => {
    const rider = await makeUser('user');
    const a = await makeBookingWithPayment({ rider, payment: { status: 'unpaid', isPaid: false } });
    const other = await makeBookingWithPayment({ rider, payment: { status: 'unpaid', isPaid: false } });
    fakeStripe.paymentIntents.retrieve.mockResolvedValue(intent('pi_a', 'succeeded', a.paymentId));

    const res = await api('/payments/confirm-payment', {
      method: 'POST', token: rider.token, body: JSON.stringify({ paymentIntentId: 'pi_a', paymentId: other.paymentId }),
    });
    const body: any = await res.json();

    expect(res.status).toBe(400);
    expect(body.message).toBe('Payment intent does not match this payment');
    expect(fakeStripe.refunds.create).not.toHaveBeenCalled();
    expect((await Payment.findById(other.paymentId).lean())?.isPaid).toBe(false);
  });

  it("another rider can not confirm someone else's payment", async () => {
    const owner = await makeUser('user');
    const intruder = await makeUser('user');
    const b = await makeBookingWithPayment({ rider: owner, payment: { status: 'unpaid', isPaid: false } });
    fakeStripe.paymentIntents.retrieve.mockResolvedValue(intent('pi_owner', 'requires_capture', b.paymentId));

    const res = await api('/payments/confirm-payment', {
      method: 'POST', token: intruder.token, body: JSON.stringify({ paymentIntentId: 'pi_owner', paymentId: b.paymentId }),
    });

    expect(res.status).toBe(403);
    expect((await Payment.findById(b.paymentId).lean())?.status).toBe('unpaid');
    expect(fakeStripe.refunds.create).not.toHaveBeenCalled();
  });

  it('the normal flow still works: owner confirms an authorized card payment', async () => {
    const rider = await makeUser('user');
    const b = await makeBookingWithPayment({ rider, payment: { status: 'unpaid', isPaid: false } });
    fakeStripe.paymentIntents.retrieve.mockResolvedValue(intent('pi_ok', 'requires_capture', b.paymentId));

    const res = await api('/payments/confirm-payment', {
      method: 'POST', token: rider.token, body: JSON.stringify({ paymentIntentId: 'pi_ok', paymentId: b.paymentId }),
    });

    expect(res.status).toBe(200);
    expect((await Payment.findById(b.paymentId).lean())?.status).toBe('authorized');
    expect((await Booking.findById(b.bookingId).lean())?.paymentStatus).toBe('authorized');
    expect(fakeStripe.refunds.create).not.toHaveBeenCalled();
  });

  it('a verified request whose captured money can not be recorded is still refunded (safety net kept)', async () => {
    const rider = await makeUser('user');
    // Captured, but the booking has no driver yet: recording fails -> money goes back.
    const b = await makeBookingWithPayment({ rider, payment: { status: 'unpaid', isPaid: false } });
    fakeStripe.paymentIntents.retrieve.mockResolvedValue(intent('pi_cap', 'succeeded', b.paymentId));

    const res = await api('/payments/confirm-payment', {
      method: 'POST', token: rider.token, body: JSON.stringify({ paymentIntentId: 'pi_cap', paymentId: b.paymentId }),
    });

    expect(res.status).toBe(400);
    expect(fakeStripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(fakeStripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_cap' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /payments/refund-payment', () => {
  it('requires login, and riders are refused', async () => {
    const rider = await makeUser('user');
    const noLogin = await api('/payments/refund-payment', { method: 'PATCH', body: JSON.stringify({ intendId: 'pi_x' }) });
    const asRider = await api('/payments/refund-payment', {
      method: 'PATCH', token: rider.token, body: JSON.stringify({ intendId: 'pi_x' }),
    });
    expect(noLogin.status).toBe(401);
    expect(asRider.status).toBe(403);
    expect(fakeStripe.refunds.create).not.toHaveBeenCalled();
  });

  it('admin can not refund the card again after the booking was already refunded (wallet)', async () => {
    const admin = await makeUser('admin');
    const rider = await makeUser('user');
    const b = await makeBookingWithPayment({
      rider, bookingStatus: 'cancelled', bookingPaymentStatus: 'refunded',
      payment: { status: 'refunded', isPaid: false, paymentIntentId: 'pi_wallet_refunded' },
    });

    const res = await api('/payments/refund-payment', {
      method: 'PATCH', token: admin.token, body: JSON.stringify({ intendId: 'pi_wallet_refunded' }),
    });

    expect(res.status).toBe(400);
    expect(fakeStripe.refunds.create).not.toHaveBeenCalled();
    expect((await Payment.findById(b.paymentId).lean())?.status).toBe('refunded');
  });

  it('admin refunds a captured payment of a cancelled booking exactly once', async () => {
    const admin = await makeUser('admin');
    const rider = await makeUser('user');
    const b = await makeBookingWithPayment({
      rider, bookingStatus: 'cancelled', bookingPaymentStatus: 'paid',
      payment: { status: 'paid', isPaid: true, paymentIntentId: 'pi_refund_me' },
    });

    const first = await api('/payments/refund-payment', {
      method: 'PATCH', token: admin.token, body: JSON.stringify({ intendId: 'pi_refund_me' }),
    });
    const second = await api('/payments/refund-payment', {
      method: 'PATCH', token: admin.token, body: JSON.stringify({ intendId: 'pi_refund_me' }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(fakeStripe.refunds.create).toHaveBeenCalledTimes(1);
    expect((await Payment.findById(b.paymentId).lean())?.status).toBe('refunded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reading payments', () => {
  it('GET /payments/:id: owner, driver and admin can read; another rider can not', async () => {
    const owner = await makeUser('user');
    const driver = await makeUser('provider');
    const other = await makeUser('user');
    const admin = await makeUser('admin');
    const b = await makeBookingWithPayment({
      rider: owner, driver, bookingStatus: 'accepted', bookingPaymentStatus: 'paid',
      payment: { status: 'paid', isPaid: true },
    });

    const as = (u: TUser) => api(`/payments/${b.paymentId}`, { token: u.token });
    expect((await as(other)).status).toBe(403);
    expect((await as(owner)).status).toBe(200);
    expect((await as(driver)).status).toBe(200);
    expect((await as(admin)).status).toBe(200);
  });

  it('GET /payments/booking/:id: needs login and access to that booking', async () => {
    const owner = await makeUser('user');
    const other = await makeUser('user');
    const b = await makeBookingWithPayment({
      rider: owner, bookingStatus: 'accepted', bookingPaymentStatus: 'paid', payment: { status: 'paid', isPaid: true },
    });

    expect((await api(`/payments/booking/${b.bookingId}`)).status).toBe(401);
    expect((await api(`/payments/booking/${b.bookingId}`, { token: other.token })).status).toBe(403);
    const ok = await api(`/payments/booking/${b.bookingId}`, { token: owner.token });
    const body: any = await ok.json();
    expect(ok.status).toBe(200);
    expect(body.data.data).toHaveLength(1);
  });
});
