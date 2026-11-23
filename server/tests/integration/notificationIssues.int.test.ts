/**
 * Client QA issues 4, 8, 9 and 13 (second QA document) end to end, against REAL
 * MongoDB + Redis, the real Express app, real Socket.io with JWT auth and the real
 * handlers. Only Firebase delivery and Google Maps are faked (setup.ts); every push
 * the server sends is captured from `messaging.sendEach`.
 *
 * One private ride is driven through the whole lifecycle over sockets, like QA does:
 * accept -> start (double tap) -> arrived -> location ping -> pickup (OTP) ->
 * drop-off -> complete.
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
import { Payment } from '../../src/app/modules/payment/payment.model';
import { notifyRiderDriversNotified } from '../../src/app/utils/notifyDrivers.utils';
import { getRideStartOtpKey } from '../../src/app/utils/rideStartOtp.utils';
import { apiFor, connectClient, localParts, wait, type RawClient } from './helpers';

const SECRET = 'it-access-secret';
const PICKUP = { lat: 35.1856, lng: 33.3823 };
const DEST = { lat: 34.6786, lng: 33.0413 };
const point = (p: { lat: number; lng: number }, address: string) => ({ address, coordinates: [p.lng, p.lat] });

let server: http.Server;
let port: number;
const api = apiFor(() => port);
let driverId: string;
let riderId: string;
let driverToken: string;
let riderToken: string;
let driver: RawClient;
let rider: RawClient;

/** Every push the server sent to the rider's device. */
const riderPushes = (type?: string) =>
  vi
    .mocked(messaging.sendEach)
    .mock.calls.flatMap(([msgs]) => msgs as any[])
    .filter((m) => m.token === 'rider-fcm' && (!type || m.data?.type === type));

const makeRide = async (opts: {
  date: string;
  time: string;
  status?: string;
  assignDriver?: boolean;
  passengerStatus?: string;
}) => {
  const ride = await Ride.create({
    type: 'private',
    rideCreatedBy: riderId,
    pickup: point(PICKUP, 'Nicosia'),
    destination: point(DEST, 'Limassol'),
    departureDate: opts.date,
    departureTime: opts.time,
    totalSeats: 0,
    status: opts.status ?? 'pending',
    ...(opts.assignDriver ? { driverId } : {}),
  } as any);
  const passenger = await Passenger.create({
    userId: riderId,
    rideId: ride._id,
    pickup: point(PICKUP, 'Nicosia'),
    destination: point(DEST, 'Limassol'),
    departureDate: opts.date,
    departureTime: opts.time,
    requestedSeats: 1,
    fareType: 'day',
    estimatedFare: 20,
    status: opts.passengerStatus ?? 'pending',
    paymentStatus: 'authorized',
  } as any);
  const booking = await Booking.create({
    passengerId: passenger._id,
    userId: riderId,
    rideId: ride._id,
    totalFare: 20,
    amountPaid: 0,
    paymentStatus: 'authorized', // the driver list only shows paid/authorized bookings
  } as any);
  return { rideId: String(ride._id), passengerId: String(passenger._id), bookingId: String(booking._id) };
};

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
    name: 'Driver Two',
    email: 'driver2@example.com',
    role: 'provider',
    fcmToken: 'driver-fcm',
    location: { type: 'Point', coordinates: [PICKUP.lng, PICKUP.lat] },
  } as any);
  const rdr = await User.create({ ...base, name: 'Rider Two', email: 'rider2@example.com', role: 'user', fcmToken: 'rider-fcm' } as any);
  driverId = String(drv._id);
  riderId = String(rdr._id);
  await Vehicle.create({ userId: drv._id, name: 'Skoda Octavia', number: 'KYZ 777', year: 2022, seats: 4, isDefault: true } as any);
  driverToken = createToken({ userId: drv._id, email: 'driver2@example.com', role: 'provider' }, SECRET, '1h');
  riderToken = createToken({ userId: rdr._id, email: 'rider2@example.com', role: 'user' }, SECRET, '1h');

  driver = await connectClient(port, driverToken);
  expect((await driver.request('driver:go-online', { ...PICKUP }))?.success).toBe(true);
  rider = await connectClient(port, riderToken);
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

const tomorrow = localParts(new Date(Date.now() + 26 * 3600_000)).date;

describe('ISSUE 8: Stripe capture fails when the driver accepts', () => {
  it('ride goes back to searching (not stuck "accepted"), rider is told to check payment', async () => {
    const b = await makeRide({ date: tomorrow, time: '15:00' });
    await Payment.collection.insertOne({
      user: new mongoose.Types.ObjectId(riderId),
      booking: new mongoose.Types.ObjectId(b.bookingId),
      method: 'card',
      transactionId: 'tx-reauth',
      status: 'requires_reauthorization',
      amount: 20,
      isPaid: false,
      createdAt: new Date(),
    });
    vi.mocked(messaging.sendEach).mockClear();

    const ack = await driver.request('driver:accept-ride', { rideId: b.rideId, passengerId: b.passengerId });
    await wait(300);

    expect(ack?.success).toBe(false);
    const ride = await Ride.findById(b.rideId).lean();
    expect(ride?.status).toBe('pending');
    expect(ride?.driverId ?? null).toBeNull();
    expect(riderPushes('PAYMENT_ACTION_REQUIRED').map((m) => m.notification.title)).toEqual(['Payment Needs Attention']);
    expect(rider.named('ride:driver-accepted')).toHaveLength(0);
  });
});

describe('One private ride through its whole lifecycle', () => {
  let a: { rideId: string; passengerId: string; bookingId: string };

  it('ISSUE 8 + 4: accept -> rider gets the live event and ONE push that expires after 10 min and collapses', async () => {
    a = await makeRide({ date: tomorrow, time: '10:00' });
    vi.mocked(messaging.sendEach).mockClear();

    const ack = await driver.request('driver:accept-ride', { rideId: a.rideId, passengerId: a.passengerId });
    const event = await rider.waitFor('ride:driver-accepted');
    await wait(300);

    expect(ack?.success).toBe(true);
    expect(String(event.passengerId ?? event.passenger?._id ?? a.passengerId)).toBe(a.passengerId);
    const pushes = riderPushes('RIDE_ACCEPTED');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].android.ttl).toBe(600_000);
    expect(pushes[0].android.collapseKey).toBe(`RIDE_ACCEPTED:${a.passengerId}`);
    expect(pushes[0].apns.headers['apns-collapse-id']).toBe(`RIDE_ACCEPTED:${a.passengerId}`);
  });

  it('ISSUE 9: driver double-taps "start trip" -> ONE push "Driver On The Way", ONE trip-started event', async () => {
    vi.mocked(messaging.sendEach).mockClear();
    const before = rider.named('ride:trip-started').length;

    const acks = await Promise.all([
      driver.request('driver:start-trip', { rideId: a.rideId }),
      driver.request('driver:start-trip', { rideId: a.rideId }),
    ]);
    await wait(500);

    expect(acks.every((x) => x?.success)).toBe(true);
    expect(riderPushes('TRIP_STARTED').map((m) => m.notification.title)).toEqual(['Driver On The Way']);
    expect(rider.named('ride:trip-started').length - before).toBe(1);
    expect((await Ride.findById(a.rideId).lean())?.status).toBe('started');
  });

  it('ISSUE 13: driver arrives -> arrival event says phase "arrived", eta 0, tapped manually', async () => {
    const ack = await driver.request('driver:arrived-pickup', { rideId: a.rideId, ...PICKUP });
    const arrived = await rider.waitFor('ride:driver-arrived');

    expect(ack?.success).toBe(true);
    expect(arrived).toMatchObject({ phase: 'arrived', eta: 0, passengerStatus: 'driver_arrived', autoDetected: false });
  });

  it('ISSUE 13: the next location ping tells the rider eta 0 / "arrived" (was "arriving in 1 min")', async () => {
    const before = rider.named('ride:live-update').length;

    await driver.request('driver:location-update', { ...PICKUP });
    await wait(300);

    const updates = rider.named('ride:live-update').slice(before);
    expect(updates).toHaveLength(1); // one update, not a personal one + a ride-room one
    expect(updates[0]).toMatchObject({ phase: 'arrived', eta: 0, distance: 0, passengerId: a.passengerId });
  });

  it('ISSUE 9: two pickup attempts without OTP -> the SAME code, pushed once', async () => {
    vi.mocked(messaging.sendEach).mockClear();

    const first = await driver.request('driver:pickup-ride', { rideId: a.rideId });
    const code1 = await getRedisClient().get(getRideStartOtpKey(a.rideId, a.passengerId));
    const second = await driver.request('driver:pickup-ride', { rideId: a.rideId });
    const code2 = await getRedisClient().get(getRideStartOtpKey(a.rideId, a.passengerId));
    await wait(300);

    expect(first?.requiresOtp).toBe(true);
    expect(second?.requiresOtp).toBe(true);
    expect(code2).toBe(code1);
    expect(riderPushes('RIDE_START_OTP')).toHaveLength(1);
  });

  it('pickup with the OTP -> ONE "Trip Started!" push', async () => {
    vi.mocked(messaging.sendEach).mockClear();
    const otp = await getRedisClient().get(getRideStartOtpKey(a.rideId, a.passengerId));

    const ack = await driver.request('driver:pickup-ride', { rideId: a.rideId, passengerId: a.passengerId, otp });
    await wait(300);

    expect(ack?.success).toBe(true);
    expect(riderPushes('PASSENGER_PICKED_UP').map((m) => m.notification.title)).toEqual(['Trip Started!']);
  });

  it('ISSUE 9: drop-off then complete -> ONE "trip finished" push (was "dropped off" + "Trip Completed!")', async () => {
    vi.mocked(messaging.sendEach).mockClear();

    const drop = await driver.request('driver:drop-off-passenger', { rideId: a.rideId });
    const done = await driver.request('driver:complete-trip', { rideId: a.rideId });
    await wait(500);

    expect(drop?.success).toBe(true);
    expect(done?.success).toBe(true);
    // Count by title: the old "Trip Completed!" push carried no data.type at all.
    const finished = riderPushes().filter((m) =>
      ['You have been dropped off', 'Trip Completed!'].includes(m.notification.title),
    );
    expect(finished).toHaveLength(1);
    expect(rider.named('ride:trip-completed')).toHaveLength(1);
  });
});

describe("ISSUE 13: yesterday's ride does not show in Upcoming", () => {
  let past: string;
  let future: string;

  it('setup: an accepted ride from yesterday that never started, and one for tomorrow', async () => {
    const yesterday = localParts(new Date(Date.now() - 24 * 3600_000)).date;
    past = (await makeRide({ date: yesterday, time: '18:00', status: 'accepted', assignDriver: true, passengerStatus: 'confirmed' })).rideId;
    future = (await makeRide({ date: tomorrow, time: '09:00', status: 'accepted', assignDriver: true, passengerStatus: 'confirmed' })).rideId;
  });

  it.each(['upcoming', 'accepted', 'accepted,started'])('rider list ?status=%s', async (status) => {
    const body = JSON.stringify(await (await api(`/ride/rider-rides?status=${status}`, { token: riderToken })).json());

    expect(body).toContain(future);
    expect(body).not.toContain(past);
  });

  it.each(['upcoming', 'accepted', 'accepted,started'])('driver list ?status=%s', async (status) => {
    const body = JSON.stringify(await (await api(`/ride/driver-rides?status=${status}`, { token: driverToken })).json());

    expect(body).toContain(future);
    expect(body).not.toContain(past);
  });
});

describe('ISSUE 9: "Drivers Notified" then "Still Searching" with the same count', () => {
  it('the re-match does not push the same news again', async () => {
    const s = await makeRide({ date: tomorrow, time: '20:00' });
    await Ride.updateOne(
      { _id: s.rideId },
      { $set: { notifiedDriverIds: [0, 1, 2].map(() => new mongoose.Types.ObjectId()) } },
    );
    vi.mocked(messaging.sendEach).mockClear();

    const args = { io: getIO(), userId: riderId, rideId: s.rideId, passengerId: s.passengerId, newlyNotified: 0 };
    await notifyRiderDriversNotified({ ...args, variant: 'matching' });
    await notifyRiderDriversNotified({ ...args, variant: 'rematch', rematchStage: 'initial' });
    await notifyRiderDriversNotified({ ...args, variant: 'rematch', rematchStage: 'final' });

    expect(riderPushes('DRIVERS_NOTIFIED')).toHaveLength(1);
    expect(riderPushes('RIDE_RE_MATCHING')).toHaveLength(0);
  });
});
