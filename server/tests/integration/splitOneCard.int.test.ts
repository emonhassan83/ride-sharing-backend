/**
 * App team, after QA round 4 (split rides), against REAL MongoDB + Redis + Socket.io:
 *
 *  1. Rider 2 cancelled before acceptance and the WHOLE ride was cancelled: the driver got
 *     "All passengers cancelled." and rider 1's booking went to Cancelled without notice
 *     (ride SR-0552185702). Rider 1 must keep the booking and the driver must get
 *     `ride:request-updated` with reason `passenger_left`.
 *  2. GET /passenger/ride-requests returned one row per rider, so a 2-rider split ride was
 *     two cards. It is now one row per ride, and one Accept (no passengerId) takes the
 *     whole ride; one Decline (no passengerId) hides it for this driver only.
 *  3. `ride:request-updated` carried totalSeats 0 before acceptance.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import app from '../../src/app';
import initializeSocketIO, { getIO } from '../../src/app/socket/socket.init';
import { connectRedis, getRedisClient } from '../../src/app/config/redis.config';
import { getChatPushQueue, initChatPushWorker } from '../../src/app/queues/chatPush.queue';
import { createToken } from '../../src/app/modules/auth/auth.utils';
import { User } from '../../src/app/modules/user/user.model';
import { Ride } from '../../src/app/modules/ride/ride.model';
import { Passenger } from '../../src/app/modules/passenger/passenger.model';
import { Booking } from '../../src/app/modules/booking/booking.model';
import { Vehicle } from '../../src/app/modules/vehicle/vehicle.model';
import { apiFor, connectClient, localParts, wait, type RawClient } from './helpers';

const SECRET = 'it-access-secret';
const PICKUP = { lat: 35.1856, lng: 33.3823 };
const DEST = { lat: 34.6786, lng: 33.0413 };
const point = (p: { lat: number; lng: number }, address: string) => ({ address, coordinates: [p.lng, p.lat] });
const tomorrow = localParts(new Date(Date.now() + 26 * 3600_000)).date;

let server: http.Server;
let port: number;
const api = apiFor(() => port);

type TUser = { id: string; token: string };
let seq = 0;
const makeUser = async (role: 'user' | 'provider'): Promise<TUser> => {
  seq += 1;
  const email = `oc-${role}-${seq}@example.com`;
  const u = await User.create({
    status: 'active', isKycVerified: true, isDeleted: false, language: 'en',
    name: `OC ${role} ${seq}`, email, phone: `+3579700${String(seq).padStart(4, '0')}`, role, wallet: 0,
    ...(role === 'provider' ? { location: { type: 'Point', coordinates: [PICKUP.lng, PICKUP.lat] } } : {}),
  } as any);
  return { id: String(u._id), token: createToken({ userId: u._id, email, role }, SECRET, '1h') };
};

let driver: TUser;
let driverSocket: RawClient;

/** A pending split ride with N riders (oldest first), each with an authorized booking. */
const makeSplitRide = async (riders: TUser[], notified: string[]) => {
  const ride = await Ride.create({
    type: 'split', rideCreatedBy: riders[0].id, pickup: point(PICKUP, 'Nicosia'),
    destination: point(DEST, 'Limassol'), departureDate: tomorrow, departureTime: '10:00',
    totalSeats: 0, bookedSeats: riders.length, status: 'pending', notifiedDriverIds: notified,
  } as any);
  const passengers: string[] = [];
  for (const [i, r] of riders.entries()) {
    const p = await Passenger.create({
      userId: r.id, rideId: ride._id, pickup: point(PICKUP, 'Nicosia'), destination: point(DEST, 'Limassol'),
      departureDate: tomorrow, departureTime: '10:00', requestedSeats: 1, fareType: 'day',
      estimatedDistanceKm: 70, estimatedFare: 20, status: 'pending', paymentStatus: 'authorized',
      createdAt: new Date(Date.now() - (riders.length - i) * 60_000),
    } as any);
    await Booking.create({
      passengerId: p._id, userId: r.id, rideId: ride._id, totalFare: 20, amountPaid: 0,
      bookingStatus: 'pending', paymentStatus: 'authorized',
    } as any);
    passengers.push(String(p._id));
  }
  return { rideId: String(ride._id), passengers };
};

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URL as string);
  await mongoose.connection.dropDatabase();
  await Promise.all([User.syncIndexes(), Ride.syncIndexes(), Passenger.syncIndexes(), Booking.syncIndexes(), Vehicle.syncIndexes()]);
  await connectRedis();
  await getRedisClient().flushdb();
  server = http.createServer(app);
  initializeSocketIO(server);
  initChatPushWorker();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;

  driver = await makeUser('provider');
  // A 6-seat car: totalSeats must be the driver's own capacity, not a fixed 4 and not 0.
  await Vehicle.create({ userId: driver.id, name: 'VW Caravelle', number: 'KXX 600', year: 2022, seats: 6, isDefault: true } as any);
  driverSocket = await connectClient(port, driver.token);
  expect((await driverSocket.request('driver:go-online', { ...PICKUP }))?.success).toBe(true);
});

afterAll(async () => {
  driverSocket?.close();
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

describe('1. one rider leaves a 2-rider split ride before acceptance', () => {
  it('the other rider keeps the booking; the driver gets ride:request-updated (passenger_left, real seats)', async () => {
    const melisa = await makeUser('user');
    const leaver = await makeUser('user');
    const r = await makeSplitRide([melisa, leaver], [driver.id]);
    const melisaSocket = await connectClient(port, melisa.token);
    const leaverSocket = await connectClient(port, leaver.token);
    await wait(150);

    const ack = await leaverSocket.request('ride:cancel-before-accept', { rideId: r.rideId });
    await wait(400);

    expect(ack).toMatchObject({ success: true, data: { rideCancelled: false, remainingPassengers: 1 } });
    expect((await Ride.findById(r.rideId).lean())?.status).toBe('pending');
    expect((await Passenger.findById(r.passengers[0]).lean())?.status).toBe('pending');
    expect((await Booking.findOne({ passengerId: r.passengers[0] }).lean())?.bookingStatus).toBe('pending');
    expect((await Passenger.findById(r.passengers[1]).lean())?.status).toBe('cancelled');

    // Melisa is told a co-rider left, NOT that her ride was cancelled.
    expect(melisaSocket.named('ride:cancelled')).toHaveLength(0);
    expect(melisaSocket.named('ride:co-passenger-cancelled')).toHaveLength(1);

    const updates = driverSocket.named('ride:request-updated').filter((u: any) => u.rideId === r.rideId);
    expect(updates[updates.length - 1]).toMatchObject({ reason: 'passenger_left', riders: 1, bookedSeats: 1, totalSeats: 6 });
    const cancelled = driverSocket.named('ride:cancelled-by-rider').filter((u: any) => u.rideId === r.rideId);
    expect(cancelled[cancelled.length - 1]).toMatchObject({ rideCancelled: false, remainingSeats: null });

    melisaSocket.close();
    leaverSocket.close();
  });

  it('the LAST rider leaving still cancels the ride', async () => {
    const solo = await makeUser('user');
    const r = await makeSplitRide([solo], [driver.id]);
    const s = await connectClient(port, solo.token);
    const ack = await s.request('ride:cancel-before-accept', { rideId: r.rideId });
    expect(ack).toMatchObject({ success: true, data: { rideCancelled: true } });
    expect((await Ride.findById(r.rideId).lean())?.status).toBe('cancelled');
    s.close();
  });
});

describe('2. one card per split ride', () => {
  it('GET /passenger/ride-requests returns ONE row for a 2-rider ride with totals and both riders', async () => {
    const a = await makeUser('user');
    const b = await makeUser('user');
    const r = await makeSplitRide([a, b], [driver.id]);

    const res = await api('/passenger/ride-requests', { token: driver.token });
    expect(res.ok).toBe(true); // the controller answers 201, unchanged
    const rows: any[] = ((await res.json()) as any).data;
    const mine = rows.filter((row) => String(row.rideId?._id ?? row.rideId) === r.rideId);

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ riders: 2, bookedSeats: 2, totalSeats: 6, totalFare: 40 });
    expect(mine[0].passengers.map((p: any) => p.passengerId)).toEqual(r.passengers);
    // Old per-rider fields stay (from the first rider), so older builds still render.
    expect(String(mine[0]._id)).toBe(r.passengers[0]);
  });

  it('driver:accept-ride with only rideId accepts EVERY pending rider', async () => {
    const a = await makeUser('user');
    const b = await makeUser('user');
    const r = await makeSplitRide([a, b], [driver.id]);

    const ack = await driverSocket.request('driver:accept-ride', { rideId: r.rideId });
    await wait(300);

    expect(ack.success).toBe(true);
    expect(ack.data.rideFullyAccepted).toBe(true);
    expect(ack.data.acceptedPassengers.map((p: any) => p.passengerId)).toEqual(r.passengers);
    expect(ack.data.skippedPassengers).toEqual([]);
    const ride = await Ride.findById(r.rideId).lean();
    expect(ride?.status).toBe('accepted');
    expect(String(ride?.driverId)).toBe(driver.id);
    expect(ride?.totalSeats).toBe(6);
    const statuses = (await Passenger.find({ rideId: r.rideId }).lean()).map((p) => p.status);
    expect(statuses).toEqual(['confirmed', 'confirmed']);
  });

  it('a rider whose booking was closed is skipped; the others are still accepted', async () => {
    const a = await makeUser('user');
    const b = await makeUser('user');
    const r = await makeSplitRide([a, b], [driver.id]);
    await Booking.updateOne({ passengerId: r.passengers[1] }, { $set: { paymentStatus: 'cancelled_authorization' } });

    const ack = await driverSocket.request('driver:accept-ride', { rideId: r.rideId });

    expect(ack.success).toBe(true);
    expect(ack.data.acceptedPassengers.map((p: any) => p.passengerId)).toEqual([r.passengers[0]]);
    expect(ack.data.skippedPassengers.map((p: any) => p.passengerId)).toEqual([r.passengers[1]]);
    expect(ack.data.rideFullyAccepted).toBe(false);
  });

  it('per-rider accept (passengerId) still works for older builds', async () => {
    const a = await makeUser('user');
    const b = await makeUser('user');
    const r = await makeSplitRide([a, b], [driver.id]);

    const ack = await driverSocket.request('driver:accept-ride', { rideId: r.rideId, passengerId: r.passengers[1] });

    expect(ack).toMatchObject({ success: true, data: { rideFullyAccepted: false, remainingPassengers: 1 } });
    expect((await Passenger.findById(r.passengers[0]).lean())?.status).toBe('pending');
  });

  it('driver:reject-ride with only rideId hides the ride for this driver; riders keep their bookings', async () => {
    const a = await makeUser('user');
    const b = await makeUser('user');
    const other = await makeUser('provider');
    const r = await makeSplitRide([a, b], [driver.id, other.id]);

    const ack = await driverSocket.request('driver:reject-ride', { rideId: r.rideId });

    expect(ack).toMatchObject({ success: true, data: { rideCancelled: false } });
    const ride = await Ride.findById(r.rideId).lean();
    expect(ride?.status).toBe('pending');
    expect((ride?.notifiedDriverIds || []).map(String)).toEqual([other.id]);
    const statuses = (await Passenger.find({ rideId: r.rideId }).lean()).map((p) => p.status);
    expect(statuses).toEqual(['pending', 'pending']);

    const rows: any[] = ((await (await api('/passenger/ride-requests', { token: driver.token })).json()) as any).data;
    expect(rows.some((row) => String(row.rideId?._id ?? row.rideId) === r.rideId)).toBe(false);
  });
});
