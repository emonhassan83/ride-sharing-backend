/**
 * Independent verification of QA round 4 (B-01..B-24) fixes: adversarial probes that
 * the original round-4 tests do not cover. Real MongoDB replica set + Redis + Express.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fakeStripe = vi.hoisted(() => ({
  paymentIntents: { retrieve: vi.fn(), create: vi.fn(), cancel: vi.fn(async () => ({})), capture: vi.fn(async () => ({ status: 'succeeded' })) },
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
import { apiFor, connectClient, localParts, wait } from './helpers';

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
  const email = `ver-${role}-${seq}@example.com`;
  const phone = `+3579800${String(seq).padStart(4, '0')}`;
  const u = await User.create({
    status: 'active', isKycVerified: true, isDeleted: false, language: 'en',
    name: `Ver ${role} ${seq}`, email, phone, role, wallet,
  } as any);
  return { id: String(u._id), token: createToken({ userId: u._id, email, role }, SECRET, '1h'), phone, email };
};

const makeRide = async (opts: {
  rider: TUser; type?: 'private' | 'split'; rideStatus?: string; driverId?: string;
  passengerStatus?: string; bookingPaymentStatus?: string; fare?: number;
}) => {
  const ride = await Ride.create({
    type: opts.type ?? 'private', rideCreatedBy: opts.rider.id, pickup: point(PICKUP, 'Nicosia'),
    destination: point(DEST, 'Limassol'), departureDate: tomorrow, departureTime: '10:00', totalSeats: 4,
    status: opts.rideStatus ?? 'pending',
    ...(opts.driverId ? { driverId: opts.driverId } : {}),
  } as any);
  const passenger = await Passenger.create({
    userId: opts.rider.id, rideId: ride._id, pickup: point(PICKUP, 'Nicosia'), destination: point(DEST, 'Limassol'),
    departureDate: tomorrow, departureTime: '10:00', requestedSeats: 1, fareType: 'day', estimatedFare: opts.fare ?? 20,
    status: opts.passengerStatus ?? 'pending', paymentStatus: 'pending',
  } as any);
  const booking = await Booking.create({
    passengerId: passenger._id, userId: opts.rider.id, rideId: ride._id, totalFare: opts.fare ?? 20, amountPaid: 0,
    bookingStatus: 'pending', paymentStatus: opts.bookingPaymentStatus ?? 'pending',
  } as any);
  return { rideId: String(ride._id), passengerId: String(passenger._id), bookingId: String(booking._id) };
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

describe('B-01 boundaries: wallet pay', () => {
  it('balance exactly equal to the fare succeeds and leaves 0', async () => {
    const rider = await makeUser('user', 20);
    const b = await makeRide({ rider });
    const res = await api('/payments/pay-with-wallet', { method: 'POST', token: rider.token, body: JSON.stringify({ booking: b.bookingId }) });
    expect(res.status).toBe(200);
    expect((await User.findById(rider.id).lean())?.wallet).toBe(0);
  });

  it('balance 0.01 short is refused, wallet and booking untouched', async () => {
    const rider = await makeUser('user', 19.99);
    const b = await makeRide({ rider });
    const res = await api('/payments/pay-with-wallet', { method: 'POST', token: rider.token, body: JSON.stringify({ booking: b.bookingId }) });
    expect(res.status).toBe(400);
    expect((await User.findById(rider.id).lean())?.wallet).toBe(19.99);
    expect((await Booking.findById(b.bookingId).lean())?.paymentStatus).toBe('pending');
  });

  it('another rider cannot pay a booking that is not theirs', async () => {
    const owner = await makeUser('user', 50);
    const thief = await makeUser('user', 50);
    const b = await makeRide({ rider: owner });
    const res = await api('/payments/pay-with-wallet', { method: 'POST', token: thief.token, body: JSON.stringify({ booking: b.bookingId }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await User.findById(thief.id).lean())?.wallet).toBe(50);
    expect((await User.findById(owner.id).lean())?.wallet).toBe(50);
  });

  it('invalid booking id / missing body are never a 500', async () => {
    const rider = await makeUser('user', 50);
    for (const body of [{}, { booking: 'nope' }, { booking: '64b000000000000000000000' }]) {
      const res = await api('/payments/pay-with-wallet', { method: 'POST', token: rider.token, body: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBeLessThan(500);
    }
  });
});

describe('B-04 quote: authorization and invalid input', () => {
  it('no token is 401; unknown or malformed ride id is 4xx, not 500', async () => {
    const rider = await makeUser('user');
    const b = await makeRide({ rider });
    expect((await api(`/ride/${b.rideId}/cancellation-quote`)).status).toBe(401);
    for (const id of ['not-an-id', '64b000000000000000000000']) {
      const res = await api(`/ride/${id}/cancellation-quote`, { token: rider.token });
      expect(res.status, id).toBeLessThan(500);
    }
  });
});

describe('Settings validation (B-04 / B-16 keys)', () => {
  it('rejects negative, over-100 and wrong-typed values; accepts 0 and 100', async () => {
    const admin = await makeUser('admin');
    const post = (body: unknown) => api('/setting/generals', { method: 'POST', token: admin.token, body: JSON.stringify(body) });
    for (const bad of [-1, 100.01, 'abc', null, {}, [], true]) {
      const r = await post({ lateCancellationFeePercent: bad });
      expect(r.status, `late=${JSON.stringify(bad)}`).toBe(400);
    }
    for (const bad of [-5, 'x']) {
      expect((await post({ splitRideMinimumFare: bad })).status, `min=${bad}`).toBe(400);
    }
    expect((await post({ lateCancellationFeePercent: 0 })).status).toBe(200);
    expect((await post({ lateCancellationFeePercent: 100 })).status).toBe(200);
    expect((await post({ cancellationFeePercent: 0 })).status).toBe(200);
  });
});

describe('B-18 gap probe: rider-facing split search', () => {
  it("a rider searching for a split ride must NOT receive other riders' phone or email", async () => {
    const riderA = await makeUser('user');
    const searcher = await makeUser('user');
    await makeRide({ rider: riderA, type: 'split', bookingPaymentStatus: 'authorized', passengerStatus: 'pending' });

    const client = await connectClient(port, searcher.token);
    const ack = await client.request('ride:find-nearby-split-ride', {
      pickup: { ...PICKUP, address: 'Nicosia' },
      destination: { ...DEST, address: 'Limassol' },
      departureDate: tomorrow,
      departureTime: '10:00',
      passengers: 1,
    });
    const text = JSON.stringify(ack);
    expect(ack.success, text).toBe(true);
    expect(ack.data.rideCount).toBeGreaterThan(0);
    expect(text).not.toContain(riderA.phone);
    expect(text).not.toContain(riderA.email);
  });
});

describe('Follow-ups: driver contact in search, malformed ids', () => {
  it('an unassigned rider sees the driver phone masked and no driver email', async () => {
    const riderA = await makeUser('user');
    const driver = await makeUser('provider');
    const searcher = await makeUser('user');
    await makeRide({ rider: riderA, type: 'split', driverId: driver.id, rideStatus: 'accepted', bookingPaymentStatus: 'authorized', passengerStatus: 'confirmed' });

    const client = await connectClient(port, searcher.token);
    const ack = await client.request('ride:find-nearby-split-ride', {
      pickup: { ...PICKUP, address: 'Nicosia' },
      destination: { ...DEST, address: 'Limassol' },
      departureDate: tomorrow,
      departureTime: '10:00',
      passengers: 1,
    });
    const text = JSON.stringify(ack);
    expect(ack.data.rideCount, text).toBeGreaterThan(0);
    expect(text).not.toContain(driver.phone);
    expect(text).not.toContain(driver.email);
    const withDriver = ack.data.drivers.find((d: any) => d.driverId);
    expect(withDriver.driverPhone).toMatch(/•/);
  });

  it('a malformed id is a 400 (was a 500 CastError) on an ordinary route', async () => {
    const rider = await makeUser('user');
    const res = await api('/ride/not-an-id', { token: rider.token });
    expect(res.status).toBe(400);
  });
});

describe('B-07: drivers get ride:request-updated when a second rider joins', () => {
  it('a notified driver receives the new seat/fare totals live; a non-notified driver does not', async () => {
    const { recalculateSplitFares } = await import('../../src/app/utils/splitFare.utils');
    const riderA = await makeUser('user');
    const riderB = await makeUser('user');
    const notified = await makeUser('provider');
    const other = await makeUser('provider');
    const a = await makeRide({ rider: riderA, type: 'split', bookingPaymentStatus: 'paid', passengerStatus: 'pending' });
    await Booking.updateOne({ _id: a.bookingId }, { $set: { amountPaid: 20 } });
    await Ride.updateOne({ _id: a.rideId }, { $set: { notifiedDriverIds: [notified.id] } });
    await Passenger.create({
      userId: riderB.id, rideId: a.rideId, pickup: point(PICKUP, 'Nicosia'), destination: point(DEST, 'Limassol'),
      departureDate: tomorrow, departureTime: '10:00', requestedSeats: 1, fareType: 'day', estimatedFare: 20,
      status: 'pending', paymentStatus: 'paid',
    } as any);

    const dn = await connectClient(port, notified.token);
    const dOther = await connectClient(port, other.token);
    await wait(200);

    await recalculateSplitFares(a.rideId, 'passenger_paid', getIO());
    await wait(500);

    const events = dn.named('ride:request-updated');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ rideId: a.rideId, riders: 2, bookedSeats: 2 });
    expect(events[0].passengers).toHaveLength(2);
    expect(dOther.named('ride:request-updated')).toHaveLength(0);
  });
});

describe('B-17 / B-21: values the app shows come from the API', () => {
  it('GET generals exposes the wait-notice fee/minutes, the start window and the fee settings', async () => {
    const rider = await makeUser('user');
    const res = await api('/setting/generals', { token: rider.token });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    const flat = JSON.stringify(body.data);
    for (const key of ['waitNoticeFeeAmount', 'waitNoticeMaxMinutes', 'tripStartEarlyWindowMinutes', 'cancellationFeePercent', 'lateCancellationFeePercent', 'splitRideMinimumFare']) {
      expect(flat, key).toContain(key);
    }
  });
});
