/**
 * Chat endpoint access control (found while answering the app team's round-4 questions),
 * against REAL MongoDB + Redis and the real Express app.
 *
 * Before:
 *  - GET /chats/:id and GET /chats/booking/:bookingId returned any chat to any logged-in
 *    user, including the other participant's email and phone.
 *  - PUT /chats/:id and DELETE /chats/:id let any logged-in user edit or delete any chat,
 *    and PUT passed the raw body to Mongo, so `participants` could be rewritten.
 *  - POST /chats let a user open a chat for a booking they are not part of.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/app/utils/s3', () => ({ deleteFromS3: vi.fn(async () => {}) }));

import app from '../../src/app';
import { connectRedis, getRedisClient } from '../../src/app/config/redis.config';
import { createToken } from '../../src/app/modules/auth/auth.utils';
import { User } from '../../src/app/modules/user/user.model';
import { Booking } from '../../src/app/modules/booking/booking.model';
import { Chat } from '../../src/app/modules/chat/chat.models';
import { apiFor, wait } from './helpers';

const SECRET = 'it-access-secret';

let server: http.Server;
let port: number;
const api = apiFor(() => port);

type TUser = { id: string; token: string };
let seq = 0;
const makeUser = async (role: 'user' | 'provider'): Promise<TUser> => {
  seq += 1;
  const email = `chat-${role}-${seq}@example.com`;
  const u = await User.create({
    status: 'active', isKycVerified: true, isDeleted: false, language: 'en',
    name: `Chat ${role} ${seq}`, email, phone: `+3579700${String(seq).padStart(4, '0')}`, role, wallet: 0,
  } as any);
  return { id: String(u._id), token: createToken({ userId: u._id, email, role }, SECRET, '1h') };
};

const makeChat = async (rider: TUser, driver: TUser) => {
  const booking = await Booking.create({
    passengerId: new mongoose.Types.ObjectId(), userId: rider.id, rideId: new mongoose.Types.ObjectId(),
    driverId: driver.id, totalFare: 20, amountPaid: 0, bookingStatus: 'accepted', paymentStatus: 'paid',
  } as any);
  const chat = await Chat.create({ booking: booking._id, participants: [rider.id, driver.id], status: 'accepted' } as any);
  return { chatId: String(chat._id), bookingId: String(booking._id) };
};

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URL as string);
  await mongoose.connection.dropDatabase();
  await Promise.all([User.syncIndexes(), Booking.syncIndexes(), Chat.syncIndexes()]);
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

describe('chat endpoints are limited to participants', () => {
  it('a participant can read the chat by id and by booking', async () => {
    const rider = await makeUser('user');
    const driver = await makeUser('provider');
    const { chatId, bookingId } = await makeChat(rider, driver);

    const byId: any = await (await api(`/chats/${chatId}`, { token: rider.token })).json();
    expect(byId.code).toBe(200);
    expect(byId.data._id).toBe(chatId);
    // Only the other side is populated.
    expect(byId.data.participants.map((p: any) => String(p._id))).toEqual([driver.id]);

    const byBooking = await api(`/chats/booking/${bookingId}`, { token: driver.token });
    expect(byBooking.status).toBe(200);
  });

  it('an outsider gets 404 and no contact details', async () => {
    const rider = await makeUser('user');
    const driver = await makeUser('provider');
    const outsider = await makeUser('user');
    const { chatId, bookingId } = await makeChat(rider, driver);

    const byId = await api(`/chats/${chatId}`, { token: outsider.token });
    expect(byId.status).toBe(404);
    expect(JSON.stringify(await byId.json())).not.toContain('@example.com');

    expect((await api(`/chats/booking/${bookingId}`, { token: outsider.token })).status).toBe(404);
  });

  it('an outsider cannot edit or delete the chat', async () => {
    const rider = await makeUser('user');
    const driver = await makeUser('provider');
    const outsider = await makeUser('provider');
    const { chatId } = await makeChat(rider, driver);

    const put = await api(`/chats/${chatId}`, {
      method: 'PUT', token: outsider.token,
      body: JSON.stringify({ name: 'pwned', participants: [outsider.id, outsider.id] }),
    });
    expect(put.status).toBe(404);

    expect((await api(`/chats/${chatId}`, { method: 'DELETE', token: outsider.token })).status).toBe(404);

    const stored = await Chat.findById(chatId).lean();
    expect(stored).not.toBeNull();
    expect(stored!.participants.map(String)).toEqual([rider.id, driver.id]);
  });

  it('a participant editing the chat cannot rewrite participants or booking', async () => {
    const rider = await makeUser('user');
    const driver = await makeUser('provider');
    const outsider = await makeUser('user');
    const { chatId, bookingId } = await makeChat(rider, driver);

    const put = await api(`/chats/${chatId}`, {
      method: 'PUT', token: rider.token,
      body: JSON.stringify({ name: 'Trip chat', participants: [rider.id, outsider.id], booking: new mongoose.Types.ObjectId() }),
    });
    expect(put.status).toBe(200);

    const stored: any = await Chat.findById(chatId).lean();
    expect(stored.participants.map(String)).toEqual([rider.id, driver.id]);
    expect(String(stored.booking)).toBe(bookingId);
  });

  it('a participant can delete the chat', async () => {
    const rider = await makeUser('user');
    const driver = await makeUser('provider');
    const { chatId } = await makeChat(rider, driver);

    expect((await api(`/chats/${chatId}`, { method: 'DELETE', token: driver.token })).status).toBe(200);
    expect(await Chat.findById(chatId)).toBeNull();
  });

  it('POST /chats refuses a caller who is not one of the participants', async () => {
    const rider = await makeUser('user');
    const driver = await makeUser('provider');
    const outsider = await makeUser('user');
    const booking = await Booking.create({
      passengerId: new mongoose.Types.ObjectId(), userId: rider.id, rideId: new mongoose.Types.ObjectId(),
      driverId: driver.id, totalFare: 20, amountPaid: 0, bookingStatus: 'accepted', paymentStatus: 'paid',
    } as any);

    const res = await api('/chats', {
      method: 'POST', token: outsider.token,
      body: JSON.stringify({ booking: String(booking._id), participants: [rider.id, driver.id] }),
    });
    expect(res.status).toBe(403);
    expect(await Chat.countDocuments({ booking: booking._id })).toBe(0);

    const ok = await api('/chats', {
      method: 'POST', token: rider.token,
      body: JSON.stringify({ booking: String(booking._id), participants: [rider.id, driver.id] }),
    });
    expect(ok.status).toBe(200);
  });
});
