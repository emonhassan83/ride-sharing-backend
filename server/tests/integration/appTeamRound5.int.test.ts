/**
 * App team, final list after QA round 4, against REAL MongoDB + Redis + Socket.io
 * (only Firebase delivery is faked, see setup.ts):
 *
 *  1. Busy driver: a driver with an accepted 17:30 ride is not offered an 18:00 ride.
 *  2. Re-match: once that 17:30 trip is completed, the 18:00 ride reaches the driver on the
 *     next sweep, even though the ride already had its single early re-notify. Before, nothing
 *     was sent until 1 hour before pickup.
 *  8. GET /notification rows had `type` but `data: {}` (Mongoose Map serialised as {}).
 *  7. KYC push: `type: KYC_STATUS`, `screen: home` (it was ACCOUNT_STATUS), saved even
 *     without an FCM token, and an FCM failure does not undo the admin's decision.
 *  9. `screen: earnings`: sent when an admin completes or cancels a payout request.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import app from '../../src/app';
import initializeSocketIO, { getIO } from '../../src/app/socket/socket.init';
import { connectRedis, getRedisClient } from '../../src/app/config/redis.config';
import { getChatPushQueue, initChatPushWorker } from '../../src/app/queues/chatPush.queue';
import { getEmailQueueInstance } from '../../src/app/utils/queueHelper';
import { createToken } from '../../src/app/modules/auth/auth.utils';
import { messaging } from '../../src/app/config/firebase.config';
import { User } from '../../src/app/modules/user/user.model';
import { Ride } from '../../src/app/modules/ride/ride.model';
import { Passenger } from '../../src/app/modules/passenger/passenger.model';
import { Booking } from '../../src/app/modules/booking/booking.model';
import { Provider } from '../../src/app/modules/provider/provider.model';
import { Withdraw } from '../../src/app/modules/withdraw/withdraw.model';
import { Vehicle } from '../../src/app/modules/vehicle/vehicle.model';
import { Setting } from '../../src/app/modules/settings/settings.model';
import { Notification } from '../../src/app/modules/notification/notification.model';
import { modeType } from '../../src/app/modules/notification/notification.interface';
import { notifyUserPush } from '../../src/app/utils/notifyUser.utils';
import { checkNoDriverFound } from '../../src/app/job/noDriverFound.job';
import { apiFor, connectClient, localParts, wait, type RawClient } from './helpers';

const SECRET = 'it-access-secret';
const PICKUP = { lat: 35.1856, lng: 33.3823 };
const DEST = { lat: 34.6786, lng: 33.0413 };
const point = (p: { lat: number; lng: number }, address: string) => ({ address, coordinates: [p.lng, p.lat] });
// 20–46 h ahead: inside the 48 h re-notify horizon, outside the 1 h final window.
const tomorrow = localParts(new Date(Date.now() + 26 * 3600_000)).date;

let server: http.Server;
let port: number;
const api = apiFor(() => port);

type TUser = { id: string; token: string };
let seq = 0;
const makeUser = async (role: 'user' | 'provider' | 'admin', extra: Record<string, unknown> = {}): Promise<TUser> => {
  seq += 1;
  const email = `r5-${role}-${seq}@example.com`;
  const u = await User.create({
    status: 'active', isKycVerified: role !== 'provider', isDeleted: false, language: 'en',
    name: `R5 ${role} ${seq}`, email, phone: `+3579800${String(seq).padStart(4, '0')}`, role, wallet: 0,
    ...(role === 'provider' ? { location: { type: 'Point', coordinates: [PICKUP.lng, PICKUP.lat] } } : {}),
    ...extra,
  } as any);
  return { id: String(u._id), token: createToken({ userId: u._id, email, role }, SECRET, '1h') };
};

const pushesTo = (token: string) =>
  vi
    .mocked(messaging.sendEach)
    .mock.calls.flatMap(([msgs]) => msgs as any[])
    .filter((m) => m.token === token);

const myNotifications = async (token: string) => {
  const res = await api('/notification?limit=50', { token });
  expect(res.ok).toBe(true);
  return ((await res.json()) as any).data as any[];
};

let admin: TUser;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URL as string);
  await mongoose.connection.dropDatabase();
  await Promise.all([User.syncIndexes(), Ride.syncIndexes(), Passenger.syncIndexes(), Booking.syncIndexes()]);
  await connectRedis();
  await getRedisClient().flushdb();
  // Same as the dev server: final continuous window 1 h, re-notify every 10 min.
  await Setting.create([{ key: 'matchingLastNotifyHours', value: 1 }, { key: 'waitingReminderIntervals', value: 10 }] as any);
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
  await (await getEmailQueueInstance()).close();
  await getRedisClient().quit();
  await mongoose.disconnect();
});

describe('1 + 2. busy driver, then re-match after the overlapping trip is completed', () => {
  let driver: TUser;
  let driverSocket: RawClient;
  let busyRideId: string;
  let rideId: string;

  it('setup: online driver with an accepted 17:30 private ride; an 18:00 split ride is waiting', async () => {
    driver = await makeUser('provider', { isKycVerified: true });
    await Vehicle.create({ userId: driver.id, name: 'Toyota Corolla', number: 'KXX 501', year: 2021, seats: 4, isDefault: true } as any);
    driverSocket = await connectClient(port, driver.token);
    expect((await driverSocket.request('driver:go-online', { ...PICKUP }))?.success).toBe(true);

    const busy = await Ride.create({
      type: 'private', rideCreatedBy: (await makeUser('user')).id, driverId: driver.id,
      pickup: point(PICKUP, 'Nicosia'), destination: point(DEST, 'Limassol'),
      departureDate: tomorrow, departureTime: '17:30', totalSeats: 4, bookedSeats: 1, status: 'accepted',
    } as any);
    busyRideId = String(busy._id);

    const rider = await makeUser('user');
    const ride = await Ride.create({
      type: 'split', rideCreatedBy: rider.id, pickup: point(PICKUP, 'Nicosia'),
      destination: point(DEST, 'Limassol'), departureDate: tomorrow, departureTime: '18:00',
      totalSeats: 0, bookedSeats: 1, status: 'pending', notifiedDriverIds: [],
      createdAt: new Date(Date.now() - 10 * 60_000),
    } as any);
    rideId = String(ride._id);
    const p = await Passenger.create({
      userId: rider.id, rideId, pickup: point(PICKUP, 'Nicosia'), destination: point(DEST, 'Limassol'),
      departureDate: tomorrow, departureTime: '18:00', requestedSeats: 1, fareType: 'day',
      estimatedDistanceKm: 70, estimatedFare: 20, status: 'pending', paymentStatus: 'authorized',
    } as any);
    await Booking.create({
      passengerId: p._id, userId: rider.id, rideId, totalFare: 20, amountPaid: 0,
      bookingStatus: 'pending', paymentStatus: 'authorized',
    } as any);
  });

  it('1. while the 17:30 ride is accepted, the first re-notify skips the driver (busy)', async () => {
    await checkNoDriverFound();
    await wait(200);
    const ride = await Ride.findById(rideId).lean();
    expect((ride?.notifiedDriverIds || []).map(String)).not.toContain(driver.id);
    expect(ride?.reNotifiedAt).toBeTruthy(); // the single early re-notify is used up
    expect(driverSocket.named('ride:new-request').filter((r: any) => String(r.rideId?._id) === rideId)).toHaveLength(0);
  });

  it('2. after the 17:30 trip is completed, the next sweep (10 min later) offers the 18:00 ride', async () => {
    await Ride.updateOne({ _id: busyRideId }, { $set: { status: 'completed', completedAt: new Date() } });

    // Within the 10-minute interval nothing is re-checked.
    await checkNoDriverFound();
    await wait(200);
    expect(driverSocket.named('ride:new-request').filter((r: any) => String(r.rideId?._id) === rideId)).toHaveLength(0);

    // 10 minutes later (throttle expired).
    await getRedisClient().del(`ride:matching:renotify:${rideId}`);
    await checkNoDriverFound();
    await wait(300);

    const offers = driverSocket.named('ride:new-request').filter((r: any) => String(r.rideId?._id) === rideId);
    expect(offers).toHaveLength(1);
    const ride = await Ride.findById(rideId).lean();
    expect((ride?.notifiedDriverIds || []).map(String)).toContain(driver.id);

    // A later sweep does not send the same ride to the same driver again.
    await getRedisClient().del(`ride:matching:renotify:${rideId}`);
    await checkNoDriverFound();
    await wait(200);
    expect(driverSocket.named('ride:new-request').filter((r: any) => String(r.rideId?._id) === rideId)).toHaveLength(1);
    driverSocket.close();
  });
});

describe('8. GET /notification returns the routing data', () => {
  it('a chat notification row has type, screen and chatId in data (was data: {})', async () => {
    const rider = await makeUser('user', { fcmToken: 'r5-rider-fcm' });
    await notifyUserPush({
      userId: rider.id, message: 'Ann', description: 'Hello', reference: new mongoose.Types.ObjectId().toString(),
      modelType: modeType.Booking,
      data: { type: 'CHAT_MESSAGE', screen: 'chat', chatId: 'chat-123', senderId: 'sender-1' },
    });

    const rows = await myNotifications(rider.token);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('CHAT_MESSAGE');
    expect(rows[0].data).toMatchObject({ type: 'CHAT_MESSAGE', screen: 'chat', chatId: 'chat-123', senderId: 'sender-1' });

    const one = await api(`/notification/${rows[0]._id}`, { token: rider.token });
    expect(((await one.json()) as any).data.data).toMatchObject({ screen: 'chat', chatId: 'chat-123' });
  });
});

describe('7. KYC decision push', () => {
  const makeProvider = async (userId: string) =>
    Provider.create({
      userId, vatNumber: 'CY1', ibanNumber: 'CY00', cnicFront: 'a', cnicBack: 'b', licenseFront: 'c', licenseBack: 'd',
      status: 'pending',
    } as any);

  it('approval: push + in-app row with type KYC_STATUS, screen home, kycStatus verified', async () => {
    const d = await makeUser('provider', { fcmToken: 'r5-kyc-fcm', status: 'active' });
    const prov = await makeProvider(d.id);

    const res = await api(`/provider/${prov._id}`, { method: 'PATCH', token: admin.token, body: JSON.stringify({ status: 'verified' }) });
    expect(res.ok).toBe(true);

    const push = pushesTo('r5-kyc-fcm');
    expect(push).toHaveLength(1);
    expect(push[0].data).toMatchObject({ type: 'KYC_STATUS', screen: 'home', kycStatus: 'verified' });
    const rows = await myNotifications(d.token);
    expect(rows[0]).toMatchObject({ type: 'KYC_STATUS', message: 'KYC Verification Approved' });
    expect(rows[0].data).toMatchObject({ type: 'KYC_STATUS', screen: 'home', kycStatus: 'verified' });
  });

  it('rejection without an FCM token: the decision is saved and the in-app row still exists', async () => {
    const d = await makeUser('provider', { status: 'active' });
    const prov = await makeProvider(d.id);

    const res = await api(`/provider/${prov._id}`, {
      method: 'PATCH', token: admin.token,
      body: JSON.stringify({ status: 'rejected', rejectionReason: 'Licence photo is blurry' }),
    });
    expect(res.ok).toBe(true);
    expect((await Provider.findById(prov._id).lean())?.status).toBe('rejected');
    const row = await Notification.findOne({ receiver: d.id }).lean();
    expect(row?.type).toBe('KYC_STATUS');
  });

  it('an FCM failure does not roll back the approval', async () => {
    const d = await makeUser('provider', { fcmToken: 'r5-kyc-broken', status: 'active' });
    const prov = await makeProvider(d.id);
    vi.mocked(messaging.sendEach).mockRejectedValueOnce(Object.assign(new Error('fcm down'), { code: 'messaging/internal-error' }));

    const res = await api(`/provider/${prov._id}`, { method: 'PATCH', token: admin.token, body: JSON.stringify({ status: 'verified' }) });
    expect(res.ok).toBe(true);
    expect((await Provider.findById(prov._id).lean())?.status).toBe('verified');
    expect((await User.findById(d.id).lean())?.isKycVerified).toBe(true);
  });
});

describe('9. screen: earnings', () => {
  it('an admin cancelling a payout request sends WITHDRAW_STATUS / earnings with the withdraw id', async () => {
    const d = await makeUser('provider', { fcmToken: 'r5-earn-fcm', isKycVerified: true });
    const w = await Withdraw.create({ user: d.id, amount: 42.5, status: 'pending' } as any);

    const res = await api(`/withdraw/${w._id}`, { method: 'PATCH', token: admin.token, body: JSON.stringify({ status: 'cancelled' }) });
    expect(res.ok).toBe(true);

    const push = pushesTo('r5-earn-fcm');
    expect(push).toHaveLength(1);
    expect(push[0].data).toMatchObject({
      type: 'WITHDRAW_STATUS', screen: 'earnings', withdrawId: String(w._id), withdrawStatus: 'cancelled', amount: '42.50',
    });
    const rows = await myNotifications(d.token);
    expect(rows[0].data).toMatchObject({ screen: 'earnings', withdrawId: String(w._id) });
  });
});
