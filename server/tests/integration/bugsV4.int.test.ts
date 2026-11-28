/**
 * Client QA "Bugs V4" + issue 19 follow-up, against REAL MongoDB + Redis + Socket.io:
 *
 *  A. Login with an optional `role`: when sent it must match the account.
 *  B. Blocked accounts: no login / API / socket / trip start; admin cannot block a
 *     user who is on a trip under way; block + status changes reach the socket.
 *  C. Issue 19: a started / arrived trip that was never completed (stale) no longer
 *     sits in Upcoming forever; a trip under way today still shows.
 *  D. "Accept Failed: This ride has already been accepted or cancelled":
 *     - a split Decline that carried a passengerId cancelled the whole ride;
 *     - an Accept on a stale card now says why and removes the card.
 *  E. Accept vs. rider cancel race: exactly one side wins, never both.
 *     Interleavings are forced with a one-shot spy on the model call each handler
 *     awaits just before the old race window, so the tests are deterministic.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import app from '../../src/app';
import initializeSocketIO, { getIO } from '../../src/app/socket/socket.init';
import { connectRedis, getRedisClient } from '../../src/app/config/redis.config';
import { getChatPushQueue, initChatPushWorker } from '../../src/app/queues/chatPush.queue';
import { createToken } from '../../src/app/modules/auth/auth.utils';
import { messaging } from '../../src/app/config/firebase.config';
import { User } from '../../src/app/modules/user/user.model';
import { Ride } from '../../src/app/modules/ride/ride.model';
import { Passenger } from '../../src/app/modules/passenger/passenger.model';
import { Booking } from '../../src/app/modules/booking/booking.model';
import { Payment } from '../../src/app/modules/payment/payment.model';
import { Vehicle } from '../../src/app/modules/vehicle/vehicle.model';
import { apiFor, connectClient, localParts, wait, type RawClient } from './helpers';

const SECRET = 'it-access-secret';
const PASSWORD = 'Password123!';
const PICKUP = { lat: 35.1856, lng: 33.3823 };
const DEST = { lat: 34.6786, lng: 33.0413 };
const point = (p: { lat: number; lng: number }, address: string) => ({ address, coordinates: [p.lng, p.lat] });
const HOUR = 3600_000;
const tomorrow = localParts(new Date(Date.now() + 26 * HOUR)).date;

let server: http.Server;
let port: number;
const api = apiFor(() => port);

type TUser = { id: string; token: string; email: string };
let seq = 0;
const makeUser = async (
  role: 'user' | 'provider' | 'admin',
  extra: Record<string, unknown> = {},
): Promise<TUser> => {
  seq += 1;
  const email = `v4-${role}-${seq}@example.com`;
  const u = await User.create({
    status: 'active', isKycVerified: true, isDeleted: false, isSignUpOtpVerified: true, language: 'en',
    name: `V4 ${role} ${seq}`, email, password: PASSWORD, phone: `+3579800${String(seq).padStart(4, '0')}`,
    role, wallet: 0, fcmToken: `fcm-${role}-${seq}`,
    ...(role === 'provider' ? { location: { type: 'Point', coordinates: [PICKUP.lng, PICKUP.lat] } } : {}),
    ...extra,
  } as any);
  return { id: String(u._id), email, token: createToken({ userId: u._id, email, role }, SECRET, '1h') };
};

const makeDriver = async () => {
  const d = await makeUser('provider');
  await Vehicle.create({ userId: d.id, name: 'Skoda Octavia', number: `KV ${seq}`, year: 2022, seats: 4, isDefault: true } as any);
  return d;
};

const onlineDriver = async () => {
  const d = await makeDriver();
  const s = await connectClient(port, d.token);
  expect((await s.request('driver:go-online', { ...PICKUP }))?.success).toBe(true);
  return { ...d, socket: s };
};

/** A ride with one passenger per rider and an authorized booking each. */
const makeRide = async (opts: {
  type: 'private' | 'split';
  riders: TUser[];
  notified?: string[];
  date?: string;
  time?: string;
  status?: string;
  driverId?: string;
  passengerStatus?: string;
}) => {
  const date = opts.date ?? tomorrow;
  const time = opts.time ?? '10:00';
  const ride = await Ride.create({
    type: opts.type, rideCreatedBy: opts.riders[0].id, pickup: point(PICKUP, 'Nicosia'),
    destination: point(DEST, 'Limassol'), departureDate: date, departureTime: time,
    totalSeats: opts.driverId ? 4 : 0, bookedSeats: opts.riders.length, status: opts.status ?? 'pending',
    notifiedDriverIds: opts.notified ?? [], ...(opts.driverId ? { driverId: opts.driverId } : {}),
  } as any);
  const passengers: string[] = [];
  const bookings: string[] = [];
  for (const [i, r] of opts.riders.entries()) {
    const p = await Passenger.create({
      userId: r.id, rideId: ride._id, pickup: point(PICKUP, 'Nicosia'), destination: point(DEST, 'Limassol'),
      departureDate: date, departureTime: time, requestedSeats: 1, fareType: 'day',
      estimatedDistanceKm: 70, estimatedFare: 20, status: opts.passengerStatus ?? 'pending', paymentStatus: 'authorized',
      createdAt: new Date(Date.now() - (opts.riders.length - i) * 60_000),
    } as any);
    const b = await Booking.create({
      passengerId: p._id, userId: r.id, rideId: ride._id, totalFare: 20, amountPaid: 0,
      bookingStatus: opts.driverId ? 'accepted' : 'pending', paymentStatus: 'authorized',
      ...(opts.driverId ? { driverId: opts.driverId } : {}),
    } as any);
    passengers.push(String(p._id));
    bookings.push(String(b._id));
  }
  return { rideId: String(ride._id), passengers, bookings };
};

/**
 * One-shot interception of `Model.findOne` for the call whose filter matches:
 * runs `side` (the "other party" writing) right after the read resolves, and
 * returns that read's result. Every other call goes straight through.
 */
const interceptFindOnceAfter = (
  model: any,
  matches: (filter: any) => boolean,
  side: () => Promise<unknown>,
) => {
  const original = model.findOne;
  let fired = false;
  const spy = vi.spyOn(model, 'findOne').mockImplementation(function (this: any, ...args: any[]) {
    if (!fired && matches(args[0])) {
      fired = true;
      return (async () => {
        const result = await original.apply(model, args);
        await side();
        return result;
      })() as any;
    }
    return original.apply(model, args);
  });
  return { spy, get fired() { return fired; } };
};

const pushesTo = (token: string, type?: string) =>
  vi
    .mocked(messaging.sendEach)
    .mock.calls.flatMap(([msgs]) => msgs as any[])
    .filter((m) => m.token === token && (!type || m.data?.type === type));

let admin: TUser;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URL as string);
  await mongoose.connection.dropDatabase();
  await Promise.all([
    User.syncIndexes(), Ride.syncIndexes(), Passenger.syncIndexes(), Booking.syncIndexes(),
    Vehicle.syncIndexes(), Payment.syncIndexes(),
  ]);
  await connectRedis();
  await getRedisClient().flushdb();
  server = http.createServer(app);
  initializeSocketIO(server);
  initChatPushWorker();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
  admin = await makeUser('admin');
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
describe('A. login with an optional role', () => {
  const login = (email: string, role?: string) =>
    api('/auth/login-with-email', {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD, ...(role ? { role } : {}) }),
    });

  it('driver credentials + "Passenger" (role user) are refused with a clear message', async () => {
    const d = await makeDriver();
    const res = await login(d.email, 'user');
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).message).toBe('This account is registered as a driver. Please log in as a driver.');
  });

  it('rider credentials + "Driver" (role provider) are refused', async () => {
    const r = await makeUser('user');
    const res = await login(r.email, 'provider');
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).message).toBe(
      'This account is not registered as a driver. Please log in as a passenger.',
    );
  });

  it('matching role logs in; no role (older builds) still logs in', async () => {
    const d = await makeDriver();
    expect((await login(d.email, 'provider')).status).toBe(200);
    expect((await login(d.email)).status).toBe(200);
  });

  it('an unknown role value is a validation error, not a silent login', async () => {
    const r = await makeUser('user');
    expect((await login(r.email, 'admin')).status).toBe(400);
  });

  it('the role check runs AFTER the password check (no account probing)', async () => {
    const d = await makeDriver();
    const res = await api('/auth/login-with-email', {
      method: 'POST',
      body: JSON.stringify({ email: d.email, password: 'WrongPass123!', role: 'user' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).message).toBe('Password do not matched');
  });

  it('phone login checks the role before sending an OTP', async () => {
    const d = await makeDriver();
    const phone = (await User.findById(d.id).lean())!.phone;
    const res = await api('/auth/login-with-phone', {
      method: 'POST',
      body: JSON.stringify({ phone, countryCode: '+357', role: 'user' }),
    });
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B. blocked accounts', () => {
  const block = (userId: string, status = 'blocked') =>
    api(`/user/${userId}`, { method: 'PATCH', token: admin.token, body: JSON.stringify({ status }) });

  it('a blocked account cannot log in, call the API or open a socket', async () => {
    const d = await makeDriver();
    await User.updateOne({ _id: d.id }, { $set: { status: 'blocked' } });

    const loginRes = await api('/auth/login-with-email', {
      method: 'POST',
      body: JSON.stringify({ email: d.email, password: PASSWORD }),
    });
    expect(loginRes.status).toBe(403);

    // A token issued before the block is refused too.
    expect((await api('/ride/driver-rides', { token: d.token })).status).toBe(403);
    await expect(connectClient(port, d.token)).rejects.toThrow(/blocked/i);
  });

  it('a driver blocked while connected cannot start a trip on the old socket', async () => {
    const d = await onlineDriver();
    const rider = await makeUser('user');
    const r = await makeRide({ type: 'private', riders: [rider], driverId: d.id, status: 'accepted', passengerStatus: 'confirmed',
      date: localParts(new Date()).date, time: localParts(new Date(Date.now() + 10 * 60_000)).time });
    await User.updateOne({ _id: d.id }, { $set: { status: 'blocked' } });

    const ack = await d.socket.request('driver:start-trip', { rideId: r.rideId });
    expect(ack).toMatchObject({ success: false, code: 'ACCOUNT_BLOCKED' });
    expect((await Ride.findById(r.rideId).lean())?.status).toBe('accepted');
    d.socket.close();
  });

  it('admin cannot block a driver whose trip is under way (started)', async () => {
    const d = await makeDriver();
    const rider = await makeUser('user');
    await makeRide({ type: 'private', riders: [rider], driverId: d.id, status: 'started', passengerStatus: 'in_progress',
      date: localParts(new Date()).date, time: localParts(new Date(Date.now() - 30 * 60_000)).time });

    const res = await block(d.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).message).toBe(
      'This account has an ongoing ride and cannot be blocked until the ride is finished.',
    );
    expect((await User.findById(d.id).lean())?.status).toBe('active');
  });

  it('admin cannot block a rider who is on board (picked_up)', async () => {
    const d = await makeDriver();
    const rider = await makeUser('user');
    await makeRide({ type: 'private', riders: [rider], driverId: d.id, status: 'started', passengerStatus: 'picked_up',
      date: localParts(new Date()).date, time: localParts(new Date(Date.now() - 30 * 60_000)).time });

    expect((await block(rider.id)).status).toBe(409);
  });

  it('an ACCEPTED (future) ride does not prevent blocking', async () => {
    const d = await makeDriver();
    const rider = await makeUser('user');
    await makeRide({ type: 'private', riders: [rider], driverId: d.id, status: 'accepted', passengerStatus: 'confirmed' });

    expect((await block(d.id)).status).toBe(200);
  });

  it('a STALE started trip (2 days old, never completed) does not prevent blocking', async () => {
    const d = await makeDriver();
    const rider = await makeUser('user');
    await makeRide({ type: 'private', riders: [rider], driverId: d.id, status: 'started', passengerStatus: 'in_progress',
      date: localParts(new Date(Date.now() - 48 * HOUR)).date, time: '10:00' });

    expect((await block(d.id)).status).toBe(200);
  });

  it('block: the open socket gets user:status-changed, then is disconnected', async () => {
    const d = await onlineDriver();
    expect((await block(d.id)).status).toBe(200);

    const evt = await d.socket.waitFor('user:status-changed');
    expect(evt).toMatchObject({ userId: d.id, status: 'blocked', isBlocked: true });
    const end = Date.now() + 5000;
    while (!d.socket.closed && Date.now() < end) await wait(100);
    expect(d.socket.closed).toBe(true);
  });

  it('activate (pending -> active): the open socket gets user:status-changed; unblock allows login again', async () => {
    const pendingDriver = await makeUser('provider', { status: 'pending' });
    const s = await connectClient(port, pendingDriver.token);
    expect((await block(pendingDriver.id, 'active')).status).toBe(200);
    expect(await s.waitFor('user:status-changed')).toMatchObject({ status: 'active', isBlocked: false });
    s.close();

    const d = await makeDriver();
    expect((await block(d.id)).status).toBe(200);
    expect((await block(d.id, 'active')).status).toBe(200);
    const res = await api('/auth/login-with-email', {
      method: 'POST',
      body: JSON.stringify({ email: d.email, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C. issue 19: stale started trips leave Upcoming', () => {
  let driver: TUser;
  let rider: TUser;
  let stale: string;
  let staleArrived: string;
  let live: string;
  let future: string;

  beforeAll(async () => {
    driver = await makeDriver();
    rider = await makeUser('user');
    const twoDaysAgo = localParts(new Date(Date.now() - 48 * HOUR)).date;
    const hourAgo = localParts(new Date(Date.now() - HOUR));
    stale = (await makeRide({ type: 'private', riders: [rider], driverId: driver.id, status: 'started',
      passengerStatus: 'in_progress', date: twoDaysAgo, time: '10:00' })).rideId;
    staleArrived = (await makeRide({ type: 'private', riders: [rider], driverId: driver.id, status: 'arrived',
      passengerStatus: 'driver_arrived', date: twoDaysAgo, time: '12:00' })).rideId;
    live = (await makeRide({ type: 'private', riders: [rider], driverId: driver.id, status: 'started',
      passengerStatus: 'in_progress', date: hourAgo.date, time: hourAgo.time })).rideId;
    future = (await makeRide({ type: 'private', riders: [rider], driverId: driver.id, status: 'accepted',
      passengerStatus: 'confirmed' })).rideId;
  });

  it.each(['upcoming', 'accepted,started', 'accepted,arrived,started'])('driver list ?status=%s', async (status) => {
    const body = JSON.stringify(await (await api(`/ride/driver-rides?status=${status}`, { token: driver.token })).json());
    expect(body).toContain(future);
    expect(body).not.toContain(stale);
    expect(body).not.toContain(staleArrived);
    if (status !== 'upcoming') expect(body).toContain(live);
  });

  it.each(['upcoming', 'accepted,started'])('rider list ?status=%s', async (status) => {
    const body = JSON.stringify(await (await api(`/ride/rider-rides?status=${status}`, { token: rider.token })).json());
    expect(body).toContain(future);
    expect(body).not.toContain(stale);
    expect(body).not.toContain(staleArrived);
  });

  it('the ongoing tab still shows them (they ARE still started in the DB)', async () => {
    const body = JSON.stringify(await (await api('/ride/driver-rides?status=ongoing', { token: driver.token })).json());
    expect(body).toContain(stale);
    expect(body).toContain(live);
  });

  it('admin: stale trips move from scheduled to overdue; the live one stays scheduled', async () => {
    const scheduled = JSON.stringify(await (await api('/ride?status=scheduled&limit=100', { token: admin.token })).json());
    const overdue = JSON.stringify(await (await api('/ride?status=overdue&limit=100', { token: admin.token })).json());
    expect(scheduled).not.toContain(stale);
    expect(scheduled).toContain(live);
    expect(overdue).toContain(stale);
    expect(overdue).toContain(staleArrived);
    expect(overdue).not.toContain(live);
  });

  it('nothing in the DB is changed by listing', async () => {
    expect((await Ride.findById(stale).lean())?.status).toBe('started');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('D. "Accept Failed: already accepted or cancelled"', () => {
  it('ROOT CAUSE: driver A declines a split card WITH passengerId -> ride stays pending, driver B can accept', async () => {
    const a = await onlineDriver();
    const b = await onlineDriver();
    const rider = await makeUser('user');
    const r = await makeRide({ type: 'split', riders: [rider], notified: [a.id, b.id] });

    const decline = await a.socket.request('driver:reject-ride', { rideId: r.rideId, passengerId: r.passengers[0] });
    expect(decline).toMatchObject({ success: true, data: { rideCancelled: false } });
    expect((await Ride.findById(r.rideId).lean())?.status).toBe('pending');
    expect((await Passenger.findById(r.passengers[0]).lean())?.status).toBe('pending');

    // Driver A no longer sees it; driver B does.
    const rowsA: any[] = ((await (await api('/passenger/ride-requests', { token: a.token })).json()) as any).data;
    expect(rowsA.some((row) => String(row.rideId?._id ?? row.rideId) === r.rideId)).toBe(false);

    const accept = await b.socket.request('driver:accept-ride', { rideId: r.rideId });
    expect(accept.success).toBe(true);
    expect((await Passenger.findById(r.passengers[0]).lean())?.status).toBe('confirmed');
    a.socket.close();
    b.socket.close();
  });

  it('accepting a cancelled ride: clear message, RIDE_NOT_AVAILABLE code, and the card is removed', async () => {
    const d = await onlineDriver();
    const rider = await makeUser('user');
    const r = await makeRide({ type: 'split', riders: [rider], notified: [d.id], status: 'cancelled' });

    const ack = await d.socket.request('driver:accept-ride', { rideId: r.rideId });
    expect(ack).toMatchObject({
      success: false,
      code: 'RIDE_NOT_AVAILABLE',
      message: 'This ride request was cancelled and is no longer available.',
      data: { rideId: r.rideId, rideStatus: 'cancelled' },
    });
    const removed = await d.socket.waitFor('ride:request-removed');
    expect(removed).toMatchObject({ rideId: r.rideId, reason: 'RIDE_NOT_AVAILABLE' });
    d.socket.close();
  });

  it('accepting a private ride another driver took: "accepted by another driver" + card removed', async () => {
    const d = await onlineDriver();
    const other = await makeDriver();
    const rider = await makeUser('user');
    const r = await makeRide({ type: 'private', riders: [rider], notified: [d.id, other.id], driverId: other.id,
      status: 'accepted', passengerStatus: 'confirmed' });

    const ack = await d.socket.request('driver:accept-ride', { rideId: r.rideId, passengerId: r.passengers[0] });
    expect(ack).toMatchObject({ success: false, code: 'RIDE_NOT_AVAILABLE',
      message: 'This ride has already been accepted by another driver.' });
    expect(await d.socket.waitFor('ride:request-removed')).toMatchObject({ rideId: r.rideId });
    d.socket.close();
  });

  it('a deleted ride: "no longer available", card removed', async () => {
    const d = await onlineDriver();
    const ghost = String(new mongoose.Types.ObjectId());
    const ack = await d.socket.request('driver:accept-ride', { rideId: ghost });
    expect(ack).toMatchObject({ success: false, code: 'RIDE_NOT_AVAILABLE', message: 'This ride is no longer available to accept.' });
    expect(await d.socket.waitFor('ride:request-removed')).toMatchObject({ rideId: ghost });
    d.socket.close();
  });

  it('the last rider cancelling sends ride:request-removed to every notified driver', async () => {
    const d1 = await onlineDriver();
    const d2 = await onlineDriver();
    const rider = await makeUser('user');
    const r = await makeRide({ type: 'split', riders: [rider], notified: [d1.id, d2.id] });
    const rs = await connectClient(port, rider.token);

    expect((await rs.request('ride:cancel-before-accept', { rideId: r.rideId })).success).toBe(true);
    for (const s of [d1.socket, d2.socket]) {
      expect(await s.waitFor('ride:request-removed')).toMatchObject({ rideId: r.rideId, reason: 'cancelled_by_rider' });
    }
    rs.close();
    d1.socket.close();
    d2.socket.close();
  });

  it('one rider of two leaving does NOT remove the card (it is updated instead)', async () => {
    const d = await onlineDriver();
    const a = await makeUser('user');
    const b = await makeUser('user');
    const r = await makeRide({ type: 'split', riders: [a, b], notified: [d.id] });
    const bs = await connectClient(port, b.token);

    expect((await bs.request('ride:cancel-before-accept', { rideId: r.rideId })).data.rideCancelled).toBe(false);
    await wait(400);
    expect(d.socket.named('ride:request-removed').filter((e: any) => e.rideId === r.rideId)).toHaveLength(0);
    bs.close();
    d.socket.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E. accept vs. rider-cancel race', () => {
  it('SPLIT: rider cancel lands after the accept read the passenger -> accept fails, rider stays cancelled', async () => {
    const d = await onlineDriver();
    const rider = await makeUser('user');
    const r = await makeRide({ type: 'split', riders: [rider], notified: [d.id] });

    // The accept reads the booking right after reading the passenger: cancel exactly then.
    const hook = interceptFindOnceAfter(
      Booking,
      (f) => f && String(f.passengerId) === r.passengers[0],
      () => Passenger.updateOne({ _id: r.passengers[0] }, { $set: { status: 'cancelled', cancelledBy: 'user' } }),
    );
    const ack = await d.socket.request('driver:accept-ride', { rideId: r.rideId, passengerId: r.passengers[0] });
    hook.spy.mockRestore();

    expect(hook.fired).toBe(true);
    expect(ack.success).toBe(false);
    expect(ack.message).toBe('Booking has been cancelled or refunded and cannot be accepted.');
    // Before the fix the final passenger.save() revived the rider as `confirmed`.
    expect((await Passenger.findById(r.passengers[0]).lean())?.status).toBe('cancelled');
    expect((await Ride.findById(r.rideId).lean())?.driverId ?? null).toBeNull();
    expect((await Booking.findById(r.bookings[0]).lean())?.bookingStatus).toBe('pending');
    d.socket.close();
  });

  it('SPLIT: the no-driver job cancels the ride mid-accept -> ride is NOT flipped back to accepted', async () => {
    const d = await onlineDriver();
    const rider = await makeUser('user');
    const r = await makeRide({ type: 'split', riders: [rider], notified: [d.id] });

    const hook = interceptFindOnceAfter(
      Booking,
      (f) => f && String(f.passengerId) === r.passengers[0],
      () => Ride.updateOne({ _id: r.rideId }, { $set: { status: 'cancelled' } }),
    );
    const ack = await d.socket.request('driver:accept-ride', { rideId: r.rideId, passengerId: r.passengers[0] });
    hook.spy.mockRestore();

    expect(hook.fired).toBe(true);
    expect(ack.success).toBe(false);
    const ride = await Ride.findById(r.rideId).lean();
    expect(ride?.status).toBe('cancelled');
    expect(ride?.driverId ?? null).toBeNull();
    // The claim was handed back: the passenger is not left `confirmed` on a dead ride.
    expect((await Passenger.findById(r.passengers[0]).lean())?.status).toBe('pending');
    d.socket.close();
  });

  it('PRIVATE: rider cancel lands after the accept read the passenger -> no ride claim, no capture', async () => {
    const d = await onlineDriver();
    const rider = await makeUser('user');
    const r = await makeRide({ type: 'private', riders: [rider], notified: [d.id] });

    const hook = interceptFindOnceAfter(
      Booking,
      (f) => f && String(f.passengerId) === r.passengers[0],
      () => Passenger.updateOne({ _id: r.passengers[0] }, { $set: { status: 'cancelled', cancelledBy: 'user' } }),
    );
    const ack = await d.socket.request('driver:accept-ride', { rideId: r.rideId, passengerId: r.passengers[0] });
    hook.spy.mockRestore();

    expect(hook.fired).toBe(true);
    expect(ack).toMatchObject({ success: false, code: 'RIDE_NOT_AVAILABLE' });
    expect((await Passenger.findById(r.passengers[0]).lean())?.status).toBe('cancelled');
    const ride = await Ride.findById(r.rideId).lean();
    expect(ride?.status).toBe('pending');
    expect(ride?.driverId ?? null).toBeNull();
    d.socket.close();
  });

  it('RIDER: driver accept lands after the cancel read the passenger -> cancel refused, card hold NOT released', async () => {
    const rider = await makeUser('user');
    const d = await makeDriver();
    const r = await makeRide({ type: 'split', riders: [rider], notified: [d.id] });
    const rs = await connectClient(port, rider.token);

    const hook = interceptFindOnceAfter(
      Passenger,
      (f) => f && String(f.rideId) === r.rideId && String(f.userId) === rider.id && f.status === 'pending',
      () => Passenger.updateOne({ _id: r.passengers[0] }, { $set: { status: 'confirmed' } }),
    );
    const ack = await rs.request('ride:cancel-before-accept', { rideId: r.rideId });
    hook.spy.mockRestore();

    expect(hook.fired).toBe(true);
    expect(ack).toMatchObject({ success: false, message: 'Cannot cancel: driver already accepted' });
    expect((await Passenger.findById(r.passengers[0]).lean())?.status).toBe('confirmed');
    // Old order released the hold before claiming: the accepted rider lost their payment.
    expect((await Booking.findById(r.bookings[0]).lean())?.paymentStatus).toBe('authorized');
    expect((await Ride.findById(r.rideId).lean())?.status).toBe('pending');
    rs.close();
  });

  it('PRIVATE capture failure hands the passenger back; the retry still pushes "Driver Accepted" once', async () => {
    const d = await onlineDriver();
    const rider = await makeUser('user');
    const r = await makeRide({ type: 'private', riders: [rider], notified: [d.id] });
    // Fails the capture without Stripe (as in ISSUE 8): payment needs re-authorization.
    const pay = await Payment.collection.insertOne({
      user: new mongoose.Types.ObjectId(rider.id), booking: new mongoose.Types.ObjectId(r.bookings[0]),
      method: 'card', transactionId: `tx-${r.rideId}`, status: 'requires_reauthorization', amount: 20, isPaid: false,
      createdAt: new Date(),
    });

    const first = await d.socket.request('driver:accept-ride', { rideId: r.rideId, passengerId: r.passengers[0] });
    expect(first.success).toBe(false);
    expect((await Passenger.findById(r.passengers[0]).lean())?.status).toBe('pending');

    // Rider re-authorizes (no payment record left to capture), driver retries.
    await Payment.collection.deleteOne({ _id: pay.insertedId });
    vi.mocked(messaging.sendEach).mockClear();
    const retry = await d.socket.request('driver:accept-ride', { rideId: r.rideId, passengerId: r.passengers[0] });
    await wait(300);

    expect(retry.success).toBe(true);
    expect((await Passenger.findById(r.passengers[0]).lean())?.status).toBe('confirmed');
    const riderFcm = (await User.findById(rider.id).lean())!.fcmToken as string;
    expect(pushesTo(riderFcm, 'RIDE_ACCEPTED')).toHaveLength(1);
    d.socket.close();
  });

  it('a retry by the SAME driver after success is idempotent (no second "accepted" push)', async () => {
    const d = await onlineDriver();
    const rider = await makeUser('user');
    const r = await makeRide({ type: 'split', riders: [rider], notified: [d.id] });

    expect((await d.socket.request('driver:accept-ride', { rideId: r.rideId, passengerId: r.passengers[0] })).success).toBe(true);
    await wait(300);
    vi.mocked(messaging.sendEach).mockClear();
    const again = await d.socket.request('driver:accept-ride', { rideId: r.rideId, passengerId: r.passengers[0] });
    await wait(300);

    expect(again.success).toBe(true);
    const riderFcm = (await User.findById(rider.id).lean())!.fcmToken as string;
    expect(pushesTo(riderFcm, 'RIDE_ACCEPTED')).toHaveLength(0);
    d.socket.close();
  });

  it.each([1, 2, 3, 4, 5, 6])('true concurrency #%i: accept and cancel fired together -> exactly one wins, state consistent', async () => {
    const d = await onlineDriver();
    const rider = await makeUser('user');
    const r = await makeRide({ type: 'split', riders: [rider], notified: [d.id] });
    const rs = await connectClient(port, rider.token);

    const [acc, can] = await Promise.all([
      d.socket.request('driver:accept-ride', { rideId: r.rideId, passengerId: r.passengers[0] }),
      rs.request('ride:cancel-before-accept', { rideId: r.rideId }),
    ]);
    await wait(200);

    const passenger = await Passenger.findById(r.passengers[0]).lean();
    const booking = await Booking.findById(r.bookings[0]).lean();
    const ride = await Ride.findById(r.rideId).lean();

    expect([acc.success, can.success].filter(Boolean)).toHaveLength(1);
    if (acc.success) {
      expect(passenger?.status).toBe('confirmed');
      expect(booking?.paymentStatus).toBe('authorized');
      expect(booking?.bookingStatus).toBe('accepted');
      expect(ride?.status).toBe('accepted');
    } else {
      expect(passenger?.status).toBe('cancelled');
      expect(booking?.bookingStatus).toBe('cancelled');
      expect(ride?.status).toBe('cancelled');
      expect(ride?.driverId ?? null).toBeNull();
    }
    rs.close();
    d.socket.close();
  });
});
