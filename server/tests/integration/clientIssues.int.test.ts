/**
 * Client QA issues 15, 52, 58, 61, 63, 67 end to end, against REAL services:
 * MongoDB + Redis (Docker), the Express app on a real HTTP port, the real Socket.io
 * server with real JWT auth, the real BullMQ chat-push worker, the real cron job code.
 * Only Firebase / Google Maps are faked (tests/integration/setup.ts).
 *
 * The scenarios run in order and share one database, like a QA session on one device pair.
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
import { Vehicle } from '../../src/app/modules/vehicle/vehicle.model';
import { Ride } from '../../src/app/modules/ride/ride.model';
import { Passenger } from '../../src/app/modules/passenger/passenger.model';
import { Booking } from '../../src/app/modules/booking/booking.model';
import { Chat } from '../../src/app/modules/chat/chat.models';
import { Notification } from '../../src/app/modules/notification/notification.model';
import { notifyNearbyDrivers } from '../../src/app/utils/notifyDrivers.utils';
import { checkSplitRidePendingMatches } from '../../src/app/job/splitRidePendingMatch.job';
import { apiFor, connectClient as connectRaw, localParts, wait, type RawClient } from './helpers';

const SECRET = 'it-access-secret';
const PICKUP = { lat: 35.1856, lng: 33.3823 }; // Nicosia
const DEST = { lat: 34.6786, lng: 33.0413 }; // Limassol

const connectClient = (token: string, headers: Record<string, string> = {}) => connectRaw(port, token, headers);
const api = apiFor(() => port);

// ─── shared state ────────────────────────────────────────────────────────────────
let server: http.Server;
let port: number;
let driverId: string;
let ghostId: string;
let riderId: string;
let driverToken: string;
let riderToken: string;
let driver: RawClient;
let rider: RawClient | null = null;
let rideId: string;
let passengerId: string;

const point = (p: { lat: number; lng: number }, address: string) => ({
  address,
  coordinates: [p.lng, p.lat],
});

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URL as string);
  await mongoose.connection.dropDatabase();
  await Promise.all([User.syncIndexes(), Ride.syncIndexes(), Vehicle.syncIndexes()]);
  await connectRedis();
  await getRedisClient().flushdb();

  server = http.createServer(app);
  initializeSocketIO(server);
  initChatPushWorker();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;

  const base = { status: 'active', isKycVerified: true, isDeleted: false, language: 'en' };
  const drv = await User.create({
    ...base,
    name: 'Driver One',
    email: 'driver1@example.com',
    role: 'provider',
    isOnline: false,
    fcmToken: 'driver-fcm-token',
    location: { type: 'Point', coordinates: [PICKUP.lng, PICKUP.lat] },
  } as any);
  const ghost = await User.create({
    ...base,
    name: 'Old Test Driver',
    email: 'ghost@example.com',
    role: 'provider',
    isOnline: true,
    location: { type: 'Point', coordinates: [PICKUP.lng, PICKUP.lat + 0.005] },
  } as any);
  const rdr = await User.create({ ...base, name: 'Rider One', email: 'rider1@example.com', role: 'user' } as any);
  driverId = String(drv._id);
  ghostId = String(ghost._id);
  riderId = String(rdr._id);
  await Vehicle.create({ userId: drv._id, name: 'Toyota Prius', number: 'KXA 123', year: 2020, seats: 4, isDefault: true } as any);

  driverToken = createToken({ userId: drv._id, email: 'driver1@example.com', role: 'provider' }, SECRET, '1h');
  riderToken = createToken({ userId: rdr._id, email: 'rider1@example.com', role: 'user' }, SECRET, '1h');

  // The "ghost": an old account still in the GEO index, last ping 3 hours ago, app closed.
  const redis = getRedisClient();
  await redis.geoadd('drivers:location', PICKUP.lng, PICKUP.lat + 0.005, ghostId);
  await redis.hset(`driver:${ghostId}:details`, {
    lastLat: String(PICKUP.lat + 0.005),
    lastLng: String(PICKUP.lng),
    lastUpdate: String(Date.now() - 3 * 3600_000),
  });
});

afterAll(async () => {
  driver?.close();
  rider?.close();
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

describe('ISSUES 58 / 63: going online right after connecting', () => {
  it('driver:go-online sent the instant the socket connects is handled (was dropped)', async () => {
    driver = await connectClient(driverToken);
    const ack = await driver.request('driver:go-online', { ...PICKUP }); // no delay at all

    expect(ack).toMatchObject({ success: true, data: { isOnline: true } });
    expect((await User.findById(driverId).lean())?.isOnline).toBe(true);
    expect(await getRedisClient().sismember('users:online', driverId)).toBe(1);
  });

  it('the app is told the real online state', async () => {
    const statuses = driver.named('driver:status');
    expect(statuses[statuses.length - 1]).toEqual({ isOnline: true });
  });
});

describe('ISSUES 61 / 63 / 42: dispatch reaches a parked driver, not stale accounts', () => {
  it('a driver online with the app open but no GPS ping for 3 hours receives the request live', async () => {
    const redis = getRedisClient();
    // Parked: no movement for 3 hours, so no location pings, app still open + online.
    await redis.del(`driver:${driverId}:current`);
    await redis.hset(`driver:${driverId}:details`, { lastUpdate: String(Date.now() - 3 * 3600_000) });

    const tomorrow = localParts(new Date(Date.now() + 26 * 3600_000));
    const ride = await Ride.create({
      type: 'private',
      rideCreatedBy: riderId,
      pickup: point(PICKUP, 'Nicosia'),
      destination: point(DEST, 'Limassol'),
      departureDate: tomorrow.date,
      departureTime: '10:00',
      totalSeats: 0,
      status: 'pending',
    } as any);
    const passenger = await Passenger.create({
      userId: riderId,
      rideId: ride._id,
      pickup: point(PICKUP, 'Nicosia'),
      destination: point(DEST, 'Limassol'),
      departureDate: tomorrow.date,
      departureTime: '10:00',
      requestedSeats: 1,
      fareType: 'day',
      status: 'pending',
    } as any);
    rideId = String(ride._id);
    passengerId = String(passenger._id);

    const count = await notifyNearbyDrivers(
      rideId,
      PICKUP,
      { _id: passengerId, rideType: 'private', departureDate: tomorrow.date, departureTime: '10:00', requestedSeats: 1 },
      redis,
      getIO(),
    );

    expect(count).toBe(1); // the parked driver; NOT the 3-hour-stale ghost (issue 42)
    const request = await driver.waitFor('ride:new-request');
    expect(String(request._id)).toBe(passengerId);

    const stored = await Ride.findById(rideId).lean();
    expect((stored?.notifiedDriverIds || []).map(String)).toEqual([driverId]);
    expect(await Notification.countDocuments({ receiver: driverId, reference: rideId })).toBe(1);
    expect(await Notification.countDocuments({ receiver: ghostId })).toBe(0);
  });
});

describe('ISSUE 63 / 58: reconnecting replays the request that was missed', () => {
  it('after reopening the app the driver gets status + the pending request over the socket', async () => {
    driver.close();
    await wait(300);
    driver = await connectClient(driverToken);

    const status = await driver.waitFor('driver:status');
    const pending = await driver.waitFor('ride:pending-requests');

    expect(status).toEqual({ isOnline: true }); // reconnect did NOT put the driver offline
    expect(pending.count).toBe(1);
    expect(String(pending.requests[0]._id)).toBe(passengerId);
    expect((await User.findById(driverId).lean())?.isOnline).toBe(true);
  });
});

describe('ISSUE 58: an offline driver', () => {
  it('goes offline', async () => {
    const ack = await driver.request('driver:go-offline', { ...PICKUP });
    expect(ack?.success).toBe(true);
    expect((await User.findById(driverId).lean())?.isOnline).toBe(false);
  });

  it('keeps sending location but is NOT put back into the dispatch sets', async () => {
    const ack = await driver.request('driver:location-update', { ...PICKUP });

    expect(ack).toMatchObject({ success: true, isOnline: false });
    expect(await getRedisClient().sismember('users:online', driverId)).toBe(0);
    expect(await getRedisClient().zscore('drivers:location', driverId)).toBeNull();
  });

  it('cannot accept a ride, and the ride is untouched', async () => {
    const ack = await driver.request('driver:accept-ride', { rideId, passengerId });

    expect(ack).toMatchObject({ success: false, message: 'You are offline. Go online to accept rides.' });
    const ride = await Ride.findById(rideId).lean();
    expect(ride?.status).toBe('pending');
    expect(ride?.driverId ?? null).toBeNull();
    expect((await User.findById(driverId).lean())?.isOnline).toBe(false);
  });
});

describe('ISSUE 52: chat push while the driver is on another screen', () => {
  let chatId: string;
  const pushesTo = (token: string) =>
    vi
      .mocked(messaging.sendEach)
      .mock.calls.flatMap(([msgs]) => msgs as any[])
      .filter((m) => m.token === token);

  it('setup: rider connects, driver opens the chat screen', async () => {
    const chat = await Chat.create({ participants: [riderId, driverId] } as any);
    chatId = String(chat._id);
    rider = await connectClient(riderToken);
    const joined = await driver.request('join-chat', { chatId });
    expect(joined?.success).toBe(true);
    expect(await getRedisClient().ttl(`chat:active:${chatId}:${driverId}`)).toBeLessThanOrEqual(120);
  });

  it('while the driver is looking at the chat, no push is sent (correct)', async () => {
    vi.mocked(messaging.sendEach).mockClear();
    const ack = await rider!.request('send-message', { chatId, text: 'Hello, I am outside' });
    expect(ack?.success).toBe(true);
    await wait(3500); // debounce window + worker

    expect(pushesTo('driver-fcm-token')).toHaveLength(0);
  });

  it('driver went back to the map without leave-chat; once presence lapses the next message IS pushed', async () => {
    // Fast-forward the 120 s presence window (it used to be 24 hours).
    await getRedisClient().pexpire(`chat:active:${chatId}:${driverId}`, 50);
    await wait(150);
    vi.mocked(messaging.sendEach).mockClear();

    await rider!.request('send-message', { chatId, text: 'I am at the gate' });
    await wait(4000);

    const pushes = pushesTo('driver-fcm-token');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].notification.body).toContain('I am at the gate');
  });

  it('network blip: driver reconnects on a new socket; the dead socket no longer blocks pushes', async () => {
    const oldDriver = driver;
    await oldDriver.request('join-chat', { chatId }); // presence bound to the OLD socket
    driver = await connectClient(driverToken); // new socket connects first ...
    oldDriver.terminate(); // ... then the old one drops (stale disconnect is ignored)
    await wait(500);
    vi.mocked(messaging.sendEach).mockClear();

    await rider!.request('send-message', { chatId, text: 'Are you coming?' });
    await wait(4000);

    expect(pushesTo('driver-fcm-token').map((m) => m.notification.body)).toEqual(['Are you coming?']);
  });
});

describe('ISSUE 67 / 60: readable validation errors over HTTP', () => {
  it('English: no quotes, pipes or regex', async () => {
    const res = await api(`/bookings/status/${new mongoose.Types.ObjectId()}`, {
      method: 'PATCH',
      token: driverToken,
      body: JSON.stringify({ bookingStatus: 'flying' }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.message).toMatch(/^Booking status must be one of: .+\.$/);
    expect(body.message).not.toMatch(/["|\\^$]/);
  });

  it('Russian header: translated', async () => {
    const res = await api(`/bookings/status/${new mongoose.Types.ObjectId()}`, {
      method: 'PATCH',
      token: driverToken,
      lang: 'ru',
      body: JSON.stringify({ bookingStatus: 'flying' }),
    });
    const body = await res.json();

    expect(body.message).toMatch(/^Поле «Booking status» должно быть одним из: /);
  });
});

describe('ISSUE 15: logout ends the session everywhere', () => {
  it('before logout the rider token works', async () => {
    expect((await api('/notification', { token: riderToken })).status).toBe(200);
  });

  it('logout disconnects the rider socket', async () => {
    const res = await api('/auth/logout', { method: 'POST', token: riderToken });
    expect(res.status).toBe(200);
    await wait(500);

    expect(rider!.closed).toBe(true);
    const user = await User.findById(riderId).lean();
    expect(user?.fcmToken ?? null).toBeNull();
    expect(user?.tokensValidAfter).toBeTruthy();
  });

  it('the old token is rejected by the API (401) and translated', async () => {
    const en = await api('/notification', { token: riderToken });
    const el = await api('/notification', { token: riderToken, lang: 'el' });

    expect(en.status).toBe(401);
    expect((await en.json()).message).toBe('Your session has ended. Please log in again.');
    expect((await el.json()).message).toBe('Η συνεδρία σας έληξε. Συνδεθείτε ξανά.');
  });

  it('the old token cannot reconnect the socket', async () => {
    await expect(connectClient(riderToken)).rejects.toThrow('Your session has ended. Please log in again.');
  });

  it('logging in again (new token) works immediately', async () => {
    const fresh = createToken({ userId: new mongoose.Types.ObjectId(riderId), email: 'rider1@example.com', role: 'user' }, SECRET, '1h');
    expect((await api('/notification', { token: fresh })).status).toBe(200);
    rider = await connectClient(fresh);
    expect(rider.closed).toBe(false);
  });
});

describe('ISSUE 15: Solo conversion timing (real cron job code, real DB)', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  let splitRideId: string;
  let lonePassengerId: string;

  it('setup: a split ride created 2 h ago; its only rider requested 25 min ago; pickup in 50 min', async () => {
    const pickupAt = localParts(new Date(Date.now() + 50 * 60_000));
    const ride = await Ride.create({
      type: 'split',
      rideCreatedBy: riderId,
      pickup: point(PICKUP, 'Nicosia'),
      destination: point(DEST, 'Limassol'),
      departureDate: pickupAt.date,
      departureTime: pickupAt.time,
      totalSeats: 0,
      status: 'pending',
    } as any);
    const lone = await Passenger.create({
      userId: riderId,
      rideId: ride._id,
      pickup: point(PICKUP, 'Nicosia'),
      destination: point(DEST, 'Limassol'),
      departureDate: pickupAt.date,
      departureTime: pickupAt.time,
      requestedSeats: 1,
      fareType: 'day',
      status: 'pending',
      paymentStatus: 'authorized',
    } as any);
    await Booking.create({ passengerId: lone._id, userId: riderId, rideId: ride._id, totalFare: 20, amountPaid: 0 } as any);
    await Ride.collection.updateOne({ _id: ride._id }, { $set: { createdAt: minutesAgo(120) } });
    await Passenger.collection.updateOne({ _id: lone._id }, { $set: { createdAt: minutesAgo(25) } });
    splitRideId = String(ride._id);
    lonePassengerId = String(lone._id);
  });

  it('after 25 minutes of searching the ride is NOT converted (was converted before the fix)', async () => {
    await checkSplitRidePendingMatches();

    expect((await Ride.findById(splitRideId).lean())?.type).toBe('split');
  });

  it('after a full hour of searching it IS converted to Solo', async () => {
    await Passenger.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(lonePassengerId) },
      { $set: { createdAt: minutesAgo(65) } },
    );

    await checkSplitRidePendingMatches();

    expect((await Ride.findById(splitRideId).lean())?.type).toBe('private');
    expect((await Passenger.findById(lonePassengerId).lean())?.matchedVia).toBe('solo_fallback');
  });
});
