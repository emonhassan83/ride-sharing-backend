/**
 * App team follow-up after QA round 4, against REAL MongoDB + Redis and the real Express app.
 *
 *  - POST /auth/refresh-auth: verified the refresh token with the ACCESS secret, read it only
 *    from a cookie and answered 500 for a bad token, so the app had no way to refresh.
 *  - GET /ride/driver-rides: no boarding state, so the driver app could not hide Cancel
 *    before the server refused it (CANNOT_CANCEL_AFTER_PICKUP).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import app from '../../src/app';
import { connectRedis, getRedisClient } from '../../src/app/config/redis.config';
import { createToken } from '../../src/app/modules/auth/auth.utils';
import { User } from '../../src/app/modules/user/user.model';
import { Ride } from '../../src/app/modules/ride/ride.model';
import { Passenger } from '../../src/app/modules/passenger/passenger.model';
import { Booking } from '../../src/app/modules/booking/booking.model';
import { apiFor, localParts, wait } from './helpers';

const ACCESS = 'it-access-secret';
const REFRESH = 'it-refresh-secret';
const PICKUP = { lat: 35.1856, lng: 33.3823 };
const DEST = { lat: 34.6786, lng: 33.0413 };
const point = (p: { lat: number; lng: number }, address: string) => ({ address, coordinates: [p.lng, p.lat] });
const tomorrow = localParts(new Date(Date.now() + 26 * 3600_000)).date;

let server: http.Server;
let port: number;
const api = apiFor(() => port);

let seq = 0;
const makeUser = async (role: 'user' | 'provider', emailInToken = true) => {
  seq += 1;
  const email = `fu-${role}-${seq}@example.com`;
  const u = await User.create({
    status: 'active', isKycVerified: true, isDeleted: false, language: 'en',
    name: `FU ${role} ${seq}`, email,
    phone: `+3579800${String(seq).padStart(4, '0')}`, role, wallet: 0,
  } as any);
  // The user is now looked up by userId, so a token without an email still works.
  const payload = { userId: u._id, ...(emailInToken ? { email } : {}), role } as any;
  return {
    id: String(u._id),
    token: createToken(payload, ACCESS, '1h'),
    refresh: createToken(payload, REFRESH, '7d'),
  };
};

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URL as string);
  await mongoose.connection.dropDatabase();
  await Promise.all([User.syncIndexes(), Ride.syncIndexes(), Passenger.syncIndexes(), Booking.syncIndexes()]);
  await connectRedis();
  await getRedisClient().flushdb();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await wait(100);
  await new Promise<void>((r) => server.close(() => r()));
  await getRedisClient().quit();
  await mongoose.disconnect();
});

const refresh = (body: unknown) =>
  api('/auth/refresh-auth', { method: 'POST', body: JSON.stringify(body) });

describe('POST /auth/refresh-auth', () => {
  it('a refresh token in the JSON body returns a working access token', async () => {
    const rider = await makeUser('user');
    const res = await refresh({ refreshToken: rider.refresh });
    expect(res.status).toBe(200);
    const { data }: any = await res.json();
    expect(typeof data.accessToken).toBe('string');

    // The new access token is accepted by an authenticated endpoint.
    const me = await api('/notification', { token: data.accessToken });
    expect(me.status).toBe(200);
  });

  it('works for a token without an email (user found by userId)', async () => {
    const rider = await makeUser('user', false);
    expect((await refresh({ refreshToken: rider.refresh })).status).toBe(200);
  });

  it('an access token cannot be used as a refresh token', async () => {
    const rider = await makeUser('user');
    expect((await refresh({ refreshToken: rider.token })).status).toBe(401);
  });

  it('missing, garbage or expired tokens answer 401, not 500', async () => {
    expect((await refresh({})).status).toBe(401);
    expect((await refresh({ refreshToken: 'not-a-jwt' })).status).toBe(401);
    const rider = await makeUser('user');
    const expired = createToken({ userId: rider.id, role: 'user' } as any, REFRESH, '1ms' as any);
    await wait(20);
    expect((await refresh({ refreshToken: expired })).status).toBe(401);
  });

  it('a refresh token from before logout is refused', async () => {
    const rider = await makeUser('user');
    await wait(5);
    expect((await api('/auth/logout', { method: 'POST', token: rider.token })).status).toBe(200);
    expect((await refresh({ refreshToken: rider.refresh })).status).toBe(401);
  });
});

describe('GET /ride/driver-rides boarding state', () => {
  const makeSplitRide = async (driverId: string, statuses: string[]) => {
    const riders = await Promise.all(statuses.map(() => makeUser('user')));
    const ride = await Ride.create({
      type: 'split', rideCreatedBy: riders[0].id, driverId, pickup: point(PICKUP, 'Nicosia'),
      destination: point(DEST, 'Limassol'), departureDate: tomorrow, departureTime: '10:00',
      totalSeats: 4, bookedSeats: statuses.length, status: 'started',
    } as any);
    for (const [i, status] of statuses.entries()) {
      const p = await Passenger.create({
        userId: riders[i].id, rideId: ride._id, pickup: point(PICKUP, 'Nicosia'), destination: point(DEST, 'Limassol'),
        departureDate: tomorrow, departureTime: '10:00', requestedSeats: 1, fareType: 'day',
        estimatedFare: 20, status, paymentStatus: 'paid',
      } as any);
      await Booking.create({
        passengerId: p._id, userId: riders[i].id, rideId: ride._id, driverId, totalFare: 20,
        amountPaid: 20, bookingStatus: 'accepted', paymentStatus: 'paid',
      } as any);
    }
    return String(ride._id);
  };

  it('returns pickedUpCount, canDriverCancel and per-passenger status', async () => {
    const driver = await makeUser('provider');
    const boardedRide = await makeSplitRide(driver.id, ['picked_up', 'confirmed']);
    const waitingRide = await makeSplitRide(driver.id, ['confirmed', 'driver_arrived']);

    const res = await api('/ride/driver-rides', { token: driver.token });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const rows: any[] = body.data.result ?? body.data;
    const byId = new Map(rows.map((r) => [String(r._id), r]));

    const boarded = byId.get(boardedRide);
    expect(boarded.pickedUpCount).toBe(1);
    expect(boarded.canDriverCancel).toBe(false);
    expect(boarded.passengerDetails.map((p: any) => p.status).sort()).toEqual(['confirmed', 'picked_up']);
    expect(boarded.passengerDetails[0]).toEqual(
      expect.objectContaining({ passengerId: expect.any(String), name: expect.any(String), requestedSeats: 1 }),
    );
    // Old field unchanged: still the riders' names.
    expect(boarded.passengers).toHaveLength(2);
    expect(typeof boarded.passengers[0]).toBe('string');

    const waiting = byId.get(waitingRide);
    expect(waiting.pickedUpCount).toBe(0);
    expect(waiting.canDriverCancel).toBe(true);
  });
});
