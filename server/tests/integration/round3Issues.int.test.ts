/**
 * Client QA round 3 (third QA document) backend issues, end to end against REAL
 * MongoDB (single-node replica set, for transactions) + Redis, the real Express
 * app and real Socket.io handlers. Faked: Firebase and Maps (setup.ts) and, in this
 * file, Stripe (network), so payment confirm/checkout paths can run.
 *
 *  - Issue 14: refunded/cancelled passenger revived by a late accept; refunded
 *    payment turned back into "paid"; admin "recent transactions" order.
 *  - Found while checking 14: wallet payment lost when cancelling before accept.
 *  - Issue 30: stale accepted rides blocked account deletion forever.
 *  - Issue 23: rejected driver could never resubmit KYC.
 *  - Issues 24, 27, 28, 29: ".", 1900 birth dates and 100-year-old cars accepted.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fakeStripe = vi.hoisted(() => ({
  paymentIntents: {
    retrieve: vi.fn(async (id: string) => ({ id, status: 'succeeded', amount: 2000, metadata: {} as any })),
    create: vi.fn(async () => ({ id: 'pi_new', client_secret: 'cs', status: 'requires_payment_method' })),
    cancel: vi.fn(async () => ({})),
    capture: vi.fn(async () => ({ status: 'succeeded' })),
  },
  customers: { create: vi.fn(async () => ({ id: 'cus_test' })) },
  ephemeralKeys: { create: vi.fn(async () => ({ secret: 'ek' })) },
  paymentMethods: { retrieve: vi.fn() },
  refunds: { create: vi.fn() },
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
import { Vehicle } from '../../src/app/modules/vehicle/vehicle.model';
import { Ride } from '../../src/app/modules/ride/ride.model';
import { Passenger } from '../../src/app/modules/passenger/passenger.model';
import { Booking } from '../../src/app/modules/booking/booking.model';
import { Payment } from '../../src/app/modules/payment/payment.model';
import { Refund } from '../../src/app/modules/refund/refund.model';
import { Provider } from '../../src/app/modules/provider/provider.model';
import { apiFor, connectClient, localParts, wait, type RawClient } from './helpers';

const SECRET = 'it-access-secret';
const PICKUP = { lat: 35.1856, lng: 33.3823 };
const DEST = { lat: 34.6786, lng: 33.0413 };
const point = (p: { lat: number; lng: number }, address: string) => ({ address, coordinates: [p.lng, p.lat] });
const oid = (id: string) => new mongoose.Types.ObjectId(id);

let server: http.Server;
let port: number;
const api = apiFor(() => port);
let driverId: string;
let driverToken: string;
let driver: RawClient;
let adminToken: string;

const tomorrow = localParts(new Date(Date.now() + 26 * 3600_000)).date;
const yesterday = localParts(new Date(Date.now() - 26 * 3600_000)).date;

let userSeq = 0;
const makeUser = async (role: 'user' | 'provider' | 'admin', extra: Record<string, any> = {}) => {
  userSeq += 1;
  const email = `r3-${role}-${userSeq}@example.com`;
  const user = await User.create({
    status: 'active',
    isKycVerified: true,
    isDeleted: false,
    language: 'en',
    name: `Test ${role} ${userSeq}`,
    email,
    phone: `+3579900${String(userSeq).padStart(4, '0')}`,
    role,
    wallet: 0,
    ...extra,
  } as any);
  const token = createToken({ userId: user._id, email, role }, SECRET, '1h');
  return { id: String(user._id), token };
};

const makeRide = async (opts: {
  riderId: string;
  type?: 'private' | 'split';
  date: string;
  time: string;
  status?: string;
  withDriver?: boolean;
  passengerStatus?: string;
  bookingStatus?: string;
  paymentStatus?: string;
  amountPaid?: number;
}) => {
  const ride = await Ride.create({
    type: opts.type ?? 'private',
    rideCreatedBy: opts.riderId,
    pickup: point(PICKUP, 'Nicosia'),
    destination: point(DEST, 'Limassol'),
    departureDate: opts.date,
    departureTime: opts.time,
    totalSeats: opts.type === 'split' ? 4 : 0,
    status: opts.status ?? 'pending',
    ...(opts.withDriver ? { driverId } : {}),
  } as any);
  const passenger = await Passenger.create({
    userId: opts.riderId,
    rideId: ride._id,
    pickup: point(PICKUP, 'Nicosia'),
    destination: point(DEST, 'Limassol'),
    departureDate: opts.date,
    departureTime: opts.time,
    requestedSeats: 1,
    fareType: 'day',
    estimatedFare: 20,
    status: opts.passengerStatus ?? 'pending',
    // The Passenger enum has no "refunded"; the refund lives on Booking/Payment.
    paymentStatus: opts.paymentStatus === 'refunded' ? 'paid' : opts.paymentStatus ?? 'authorized',
  } as any);
  const booking = await Booking.create({
    passengerId: passenger._id,
    userId: opts.riderId,
    rideId: ride._id,
    ...(opts.withDriver ? { driverId } : {}),
    totalFare: 20,
    amountPaid: opts.amountPaid ?? 0,
    bookingStatus: opts.bookingStatus ?? 'pending',
    paymentStatus: opts.paymentStatus ?? 'authorized',
  } as any);
  return { rideId: String(ride._id), passengerId: String(passenger._id), bookingId: String(booking._id) };
};

const insertPayment = async (doc: Record<string, any>) => {
  const res = await Payment.collection.insertOne({
    id: `PAY-${new mongoose.Types.ObjectId()}`,
    method: 'card',
    transactionId: `tx-${new mongoose.Types.ObjectId()}`,
    amount: 20,
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...doc,
  });
  return String(res.insertedId);
};

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URL as string);
  await mongoose.connection.dropDatabase();
  await Promise.all([
    User.syncIndexes(), Ride.syncIndexes(), Vehicle.syncIndexes(), Passenger.syncIndexes(),
    Booking.syncIndexes(), Payment.syncIndexes(), Refund.syncIndexes(), Provider.syncIndexes(),
  ]);
  await connectRedis();
  await getRedisClient().flushdb();

  server = http.createServer(app);
  initializeSocketIO(server);
  initChatPushWorker();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;

  const drv = await makeUser('provider', {
    fcmToken: 'driver-fcm',
    location: { type: 'Point', coordinates: [PICKUP.lng, PICKUP.lat] },
  });
  driverId = drv.id;
  driverToken = drv.token;
  await Vehicle.create({ userId: oid(driverId), name: 'Skoda Octavia', number: 'KYZ 777', year: 2022, seats: 4, isDefault: true } as any);
  adminToken = (await makeUser('admin')).token;

  driver = await connectClient(port, driverToken);
  expect((await driver.request('driver:go-online', { ...PICKUP }))?.success).toBe(true);
});

afterAll(async () => {
  driver?.close();
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
describe('ISSUE 14: a refunded / cancelled split passenger can not be revived', () => {
  it('driver accepts a split passenger whose booking was refunded -> rejected, nothing changes', async () => {
    const rider = await makeUser('user');
    const r = await makeRide({
      riderId: rider.id, type: 'split', date: tomorrow, time: '11:00',
      passengerStatus: 'cancelled', bookingStatus: 'cancelled', paymentStatus: 'refunded',
    });

    const ack = await driver.request('driver:accept-ride', { rideId: r.rideId, passengerId: r.passengerId });

    expect(ack?.success).toBe(false);
    expect(ack?.message).toBe('Booking has been cancelled or refunded and cannot be accepted.');
    const [ride, passenger, booking] = await Promise.all([
      Ride.findById(r.rideId).lean(), Passenger.findById(r.passengerId).lean(), Booking.findById(r.bookingId).lean(),
    ]);
    expect(ride?.status).toBe('pending');
    expect(ride?.driverId ?? null).toBeNull();
    expect(passenger?.status).toBe('cancelled');
    expect(booking?.bookingStatus).toBe('cancelled');
    expect(booking?.paymentStatus).toBe('refunded');
  });

  it('booking refunded by a job while the passenger still looks "pending" -> also rejected', async () => {
    const rider = await makeUser('user');
    const r = await makeRide({
      riderId: rider.id, type: 'split', date: tomorrow, time: '11:30',
      passengerStatus: 'pending', bookingStatus: 'pending', paymentStatus: 'refunded',
    });

    const ack = await driver.request('driver:accept-ride', { rideId: r.rideId, passengerId: r.passengerId });

    expect(ack?.success).toBe(false);
    expect((await Passenger.findById(r.passengerId).lean())?.status).toBe('pending');
    expect((await Booking.findById(r.bookingId).lean())?.bookingStatus).toBe('pending');
  });

  it('a repeated payment confirm can not turn a refunded payment back into "paid"', async () => {
    const rider = await makeUser('user');
    const r = await makeRide({
      riderId: rider.id, date: tomorrow, time: '12:00',
      passengerStatus: 'cancelled', bookingStatus: 'cancelled', paymentStatus: 'refunded',
    });
    const paymentId = await insertPayment({
      user: oid(rider.id), booking: oid(r.bookingId), status: 'refunded', isPaid: false, paymentIntentId: 'pi_old',
    });
    fakeStripe.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_old', status: 'succeeded', amount: 2000, metadata: { paymentId },
    });
    fakeStripe.refunds.create.mockClear();

    const res = await api('/payments/confirm-payment', {
      method: 'POST', token: rider.token, body: JSON.stringify({ paymentIntentId: 'pi_old', paymentId }),
    });

    expect(res.status).toBe(400);
    // Already refunded to the wallet: the card must not be refunded a second time.
    expect(fakeStripe.refunds.create).not.toHaveBeenCalled();
    const [payment, booking] = await Promise.all([Payment.findById(paymentId).lean(), Booking.findById(r.bookingId).lean()]);
    expect(payment?.status).toBe('refunded');
    expect(payment?.isPaid).toBe(false);
    expect(booking?.paymentStatus).toBe('refunded');
    expect(booking?.bookingStatus).toBe('cancelled');
  });

  it('checkout for a cancelled booking is refused and does not reuse the refunded payment', async () => {
    const rider = await makeUser('user');
    const r = await makeRide({
      riderId: rider.id, date: tomorrow, time: '12:30',
      passengerStatus: 'cancelled', bookingStatus: 'cancelled', paymentStatus: 'refunded',
    });
    const paymentId = await insertPayment({ user: oid(rider.id), booking: oid(r.bookingId), status: 'refunded', isPaid: false });
    fakeStripe.paymentIntents.create.mockClear();

    const res = await api('/payments/checkout', {
      method: 'POST', token: rider.token, body: JSON.stringify({ booking: r.bookingId }),
    });

    expect(res.status).toBe(400);
    expect(fakeStripe.paymentIntents.create).not.toHaveBeenCalled();
    expect((await Payment.findById(paymentId).lean())?.status).toBe('refunded');
  });

  it('admin "recent transactions" lists the most recently paid/refunded first', async () => {
    const rider = await makeUser('user');
    const old = await makeRide({ riderId: rider.id, date: tomorrow, time: '13:00' });
    const fresh = await makeRide({ riderId: rider.id, date: tomorrow, time: '13:30' });
    // Booked first, but captured last (split capture at pickup) ...
    await insertPayment({
      user: oid(rider.id), booking: oid(old.bookingId), status: 'paid', isPaid: true, transactionId: 'tx-captured-last',
      createdAt: new Date(Date.now() - 3600_000), updatedAt: new Date(Date.now() + 60_000),
    });
    // ... booked later, refunded earlier.
    await insertPayment({
      user: oid(rider.id), booking: oid(fresh.bookingId), status: 'refunded', isPaid: false, transactionId: 'tx-refunded-earlier',
      createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await api('/meta', { token: adminToken });
    const body: any = await res.json();

    expect(res.status).toBe(200);
    const rows = body.data.recentTransactions;
    expect(rows[0].transactionId).toBe('tx-captured-last');
    expect(rows[0].status).toBe('paid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Found while checking issue 14: wallet payment + cancel before a driver accepts', () => {
  it('rider gets the wallet money back exactly once, booking is closed, refund recorded', async () => {
    const rider = await makeUser('user');
    const r = await makeRide({
      riderId: rider.id, date: tomorrow, time: '14:00',
      passengerStatus: 'pending', bookingStatus: 'pending', paymentStatus: 'paid', amountPaid: 20,
    });
    const paymentId = await insertPayment({
      user: oid(rider.id), booking: oid(r.bookingId), method: 'wallet', status: 'paid', isPaid: true,
    });
    const riderSocket = await connectClient(port, rider.token);

    // Double tap on "cancel".
    const acks = await Promise.all([
      riderSocket.request('ride:cancel-before-accept', { rideId: r.rideId }),
      riderSocket.request('ride:cancel-before-accept', { rideId: r.rideId }),
    ]);
    riderSocket.close();

    expect(acks.filter((a) => a?.success)).toHaveLength(1);
    const [user, booking, payment, refunds] = await Promise.all([
      User.findById(rider.id).lean(),
      Booking.findById(r.bookingId).lean(),
      Payment.findById(paymentId).lean(),
      Refund.countDocuments({ user: oid(rider.id) }),
    ]);
    expect(user?.wallet).toBe(20);
    expect(booking?.bookingStatus).toBe('cancelled');
    expect(booking?.paymentStatus).toBe('refunded');
    expect(payment?.status).toBe('refunded');
    expect(refunds).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ISSUE 30: "Cannot delete profile while having an active ride" with no active ride', () => {
  it('an old accepted ride the driver never started no longer blocks deletion', async () => {
    const rider = await makeUser('user');
    await makeRide({
      riderId: rider.id, date: yesterday, time: '10:00', status: 'accepted', withDriver: true,
      passengerStatus: 'confirmed', bookingStatus: 'accepted', paymentStatus: 'paid', amountPaid: 20,
    });

    const res = await api(`/user/${rider.id}`, {
      method: 'DELETE', token: rider.token, body: JSON.stringify({ reason: 'I am no longer using my account' }),
    });

    expect(res.status).toBe(200);
    expect((await User.findById(rider.id).lean())?.isDeleted).toBe(true);
  });

  it('a real upcoming ride (tomorrow) still blocks deletion', async () => {
    const rider = await makeUser('user');
    await makeRide({
      riderId: rider.id, date: tomorrow, time: '10:00', status: 'accepted', withDriver: true,
      passengerStatus: 'confirmed', bookingStatus: 'accepted', paymentStatus: 'paid', amountPaid: 20,
    });

    const res = await api(`/user/${rider.id}`, {
      method: 'DELETE', token: rider.token, body: JSON.stringify({ reason: 'test' }),
    });
    const body: any = await res.json();

    expect(res.status).toBe(400);
    expect(body.message).toBe('Cannot delete profile while having an active ride');
    expect((await User.findById(rider.id).lean())?.isDeleted).toBe(false);
  });

  it('a ride that is under way blocks deletion even if it is past departure', async () => {
    const rider = await makeUser('user');
    await makeRide({
      riderId: rider.id, date: yesterday, time: '10:00', status: 'started', withDriver: true,
      passengerStatus: 'picked_up', bookingStatus: 'accepted', paymentStatus: 'paid', amountPaid: 20,
    });

    const res = await api(`/user/${rider.id}`, {
      method: 'DELETE', token: rider.token, body: JSON.stringify({ reason: 'test' }),
    });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ISSUE 23: a rejected driver can resubmit KYC', () => {
  const kyc = {
    vatNumber: 'CY12345678X',
    ibanNumber: 'CY17002001280000001200527600',
    cnicFront: 'https://files.example.com/id-front.jpg',
    cnicBack: 'https://files.example.com/id-back.jpg',
    licenseFront: 'https://files.example.com/lic-front.jpg',
    licenseBack: 'https://files.example.com/lic-back.jpg',
  };

  it('rejected -> POST /provider again -> 201, back to "pending" with the new data', async () => {
    const drv = await makeUser('provider', { type: 'self-employed', isKycVerified: false, status: 'pending' });
    await Provider.create({ userId: oid(drv.id), ...kyc, vatNumber: 'OLD-VAT', status: 'rejected', rejectionReason: 'Blurry licence photo' } as any);

    const res = await api('/provider', { method: 'POST', token: drv.token, body: JSON.stringify(kyc) });
    const body: any = await res.json();

    expect(res.status).toBe(201);
    const provider = await Provider.findOne({ userId: oid(drv.id) }).lean();
    expect(provider?.status).toBe('pending');
    expect(provider?.rejectionReason ?? null).toBeNull();
    expect(provider?.vatNumber).toBe('CY12345678X');
    expect(await Provider.countDocuments({ userId: oid(drv.id) })).toBe(1);
    expect(body.data?.status).toBe('pending');
  });

  it('retrying a submission that is still pending also succeeds (no "already sent" dead end)', async () => {
    const drv = await makeUser('provider', { type: 'self-employed', isKycVerified: false, status: 'pending' });
    expect((await api('/provider', { method: 'POST', token: drv.token, body: JSON.stringify(kyc) })).status).toBe(201);
    expect((await api('/provider', { method: 'POST', token: drv.token, body: JSON.stringify(kyc) })).status).toBe(201);
    expect(await Provider.countDocuments({ userId: oid(drv.id) })).toBe(1);
  });

  it('a verified driver still can not overwrite approved documents', async () => {
    const drv = await makeUser('provider', { type: 'self-employed' });
    await Provider.create({ userId: oid(drv.id), ...kyc, status: 'verified' } as any);

    const res = await api('/provider', { method: 'POST', token: drv.token, body: JSON.stringify({ ...kyc, vatNumber: 'NEW' }) });

    expect(res.status).toBe(409);
    expect((await Provider.findOne({ userId: oid(drv.id) }).lean())?.vatNumber).toBe('CY12345678X');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ISSUES 24, 27, 28, 29: profile and vehicle validation', () => {
  const put = (id: string, token: string, body: Record<string, unknown>) =>
    api(`/user/${id}`, { method: 'PUT', token, body: JSON.stringify(body) });

  it('ISSUE 24: sign-up with the name "." is refused', async () => {
    const res = await api('/auth/register', {
      method: 'POST', body: JSON.stringify({ name: '.', email: 'dot@example.com', phone: '+35799111222', role: 'user' }),
    });
    expect(res.status).toBe(400);
    expect(await User.countDocuments({ email: 'dot@example.com' })).toBe(0);
  });

  it('ISSUE 24: profile name "." is refused, the stored name is kept', async () => {
    const u = await makeUser('user');
    const res = await put(u.id, u.token, { name: '.' });
    const body: any = await res.json();
    expect(res.status).toBe(400);
    expect(JSON.stringify(body)).toContain('Please enter a valid name (at least 2 letters).');
    expect((await User.findById(u.id).lean())?.name).toMatch(/^Test user/);
  });

  it('ISSUE 29: address "." is refused', async () => {
    const u = await makeUser('user');
    expect((await put(u.id, u.token, { address: '.' })).status).toBe(400);
  });

  it('ISSUE 27: date of birth 20-11-1900 is refused', async () => {
    const u = await makeUser('user');
    expect((await put(u.id, u.token, { dateOfBirth: '20-11-1900' })).status).toBe(400);
  });

  it('ISSUE 27: a driver born 2015 is refused (must be 18+)', async () => {
    const drv = await makeUser('provider');
    const res = await put(drv.id, drv.token, { dateOfBirth: '2015-01-01' });
    const body: any = await res.json();
    expect(res.status).toBe(400);
    expect(body.message).toBe('Drivers must be at least 18 years old.');
  });

  it('valid profile data is still accepted', async () => {
    const u = await makeUser('user');
    const res = await put(u.id, u.token, {
      name: 'Aakib Khan', address: '12 Makariou Ave, Nicosia', dateOfBirth: '1995-05-20',
    });
    expect(res.status).toBe(200);
    const saved = await User.findById(u.id).lean();
    expect(saved?.name).toBe('Aakib Khan');
    expect(saved?.address).toBe('12 Makariou Ave, Nicosia');
  });

  it('ISSUE 28: a car older than 30 years is refused, a 2020 car is accepted', async () => {
    const drv = await makeUser('provider');
    const old = await api('/vehicles', {
      method: 'POST', token: drv.token,
      body: JSON.stringify({ name: 'Old Ferrari', number: 'ABC 123', year: new Date().getFullYear() - 31, seats: 4 }),
    });
    const oldBody: any = await old.json();
    expect(old.status).toBe(400);
    expect(JSON.stringify(oldBody)).toContain('Vehicle is too old. Please add a newer vehicle.');

    const ok = await api('/vehicles', {
      method: 'POST', token: drv.token,
      body: JSON.stringify({ name: 'Toyota Corolla', number: 'XYZ 456', year: 2020, seats: 4 }),
    });
    expect(ok.status).toBeLessThan(300);
  });
});
