/**
 * Issues 58 / 63, end to end over a REAL socket.io server and a raw WebSocket client.
 *
 * Root cause: `socket.init.ts` awaited DB/Redis lookups (User.findById, Redis,
 * Vehicle, active ride) BEFORE registering event listeners. Socket.io does not
 * buffer events, so whatever the app sent right after connecting, typically
 * `driver:go-online`, was silently dropped and the app showed the driver offline.
 *
 * The DB lookup is delayed 200 ms here, like a real Mongo round trip.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { Server } from 'socket.io';

vi.mock('@src/app/socket/utils/socket.auth', () => ({
  socketAuth: (socket: any, next: (err?: Error) => void) => {
    const auth = socket.handshake.auth || {};
    socket.auth = { _id: auth.userId, role: auth.role, language: 'en' };
    next();
  },
}));
vi.mock('@src/app/socket/socket.event', () => ({ default: vi.fn() }));
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/passenger/passenger.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Passenger: createModelMock() };
});
vi.mock('@src/app/modules/ride/ride.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Ride: createModelMock() };
});
vi.mock('@src/app/modules/vehicle/vehicle.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Vehicle: createModelMock() };
});
vi.mock('@src/app/modules/passenger/passenger.service', () => ({
  PassengerService: { getDriverRideRequest: vi.fn() },
}));

import initializeSocketIO from '@src/app/socket/socket.init';
import registerSocketEvents from '@src/app/socket/socket.event';
import { User } from '@src/app/modules/user/user.model';
import { PassengerService } from '@src/app/modules/passenger/passenger.service';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockQuery, oidStr } from '@tests/helpers/mongoose';

const DB_DELAY_MS = 200;

/** Minimal Engine.IO v4 / Socket.IO v5 client speaking the wire protocol over `ws`. */
function connectRawClient(port: number, auth: Record<string, string>) {
  const events: Array<[string, any]> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  const connected = new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = raw.toString();
      if (msg.startsWith('0{')) ws.send(`40${JSON.stringify(auth)}`); // open -> connect namespace
      else if (msg === '2') ws.send('3'); // ping -> pong
      else if (msg.startsWith('40')) resolve(); // namespace connected
      else if (msg.startsWith('42')) {
        const [event, data] = JSON.parse(msg.slice(2));
        events.push([event, data]);
      }
    });
  });
  return {
    connected,
    events,
    emit: (event: string, data: unknown) => ws.send(`42${JSON.stringify([event, data])}`),
    eventsNamed: (name: string) => events.filter(([e]) => e === name).map(([, d]) => d),
    close: () => ws.close(),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** findById(...).select(...).lean() that resolves after a delay, like a DB round trip. */
const slowQuery = (doc: unknown) => ({
  select: () => ({ lean: () => wait(DB_DELAY_MS).then(() => doc) }),
});

let httpServer: http.Server;
let port: number;
let handled: string[];
let client: ReturnType<typeof connectRawClient> | null;

const startServer = async (attachIo: (srv: http.Server) => unknown) => {
  httpServer = http.createServer();
  attachIo(httpServer);
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  port = (httpServer.address() as AddressInfo).port;
};

beforeEach(() => {
  handled = [];
  client = null;
  vi.mocked(registerSocketEvents).mockImplementation((socket: any) => {
    socket.on('driver:go-online', () => handled.push('driver:go-online'));
  });
  vi.mocked(PassengerService.getDriverRideRequest).mockResolvedValue([
    { _id: 'p1', rideId: { _id: 'r1', type: 'private' } },
  ] as any);
});

afterEach(async () => {
  client?.close();
  await new Promise<void>((r) => httpServer.close(() => r()));
});

describe('CONTROL: the original bug is real (listeners registered after an await)', () => {
  it('an event sent immediately after connecting is DROPPED by socket.io', async () => {
    await startServer((srv) => {
      const io = new Server(srv);
      io.on('connection', async (socket) => {
        await wait(DB_DELAY_MS); // the old socket.init.ts lookups
        socket.on('driver:go-online', () => handled.push('driver:go-online'));
      });
    });
    client = connectRawClient(port, {});
    await client.connected;
    client.emit('driver:go-online', { lat: 35.1, lng: 33.3 });
    await wait(DB_DELAY_MS + 200);

    expect(handled).toEqual([]);
  });
});

describe('ISSUES 58 / 63: socket.init.ts after the fix', () => {
  it('handles driver:go-online sent immediately after connecting, while the DB lookup is still running', async () => {
    const driverId = oidStr();
    vi.mocked(User.findById).mockReturnValue(slowQuery({ _id: driverId, isOnline: false }) as any);
    await startServer((srv) => initializeSocketIO(srv));

    client = connectRawClient(port, { userId: driverId, role: 'provider' });
    await client.connected;
    client.emit('driver:go-online', { lat: 35.1, lng: 33.3 });
    await wait(DB_DELAY_MS + 200);

    expect(handled).toEqual(['driver:go-online']);
  });

  it('tells a reconnecting ONLINE driver its real status and replays unanswered ride requests', async () => {
    const driverId = oidStr();
    vi.mocked(User.findById).mockReturnValue(
      slowQuery({ _id: driverId, isOnline: true, name: 'D', location: { coordinates: [33.3, 35.1] } }) as any,
    );
    await startServer((srv) => initializeSocketIO(srv));

    client = connectRawClient(port, { userId: driverId, role: 'provider' });
    await client.connected;
    await wait(DB_DELAY_MS + 200);

    expect(client.eventsNamed('driver:status')).toEqual([{ isOnline: true }]);
    expect(client.eventsNamed('ride:pending-requests')).toEqual([
      { count: 1, requests: [{ _id: 'p1', rideId: { _id: 'r1', type: 'private' } }] },
    ]);
    expect(PassengerService.getDriverRideRequest).toHaveBeenCalledWith(driverId);
    expect(await fakeRedis.sismember('users:online', driverId)).toBe(1);
  });

  it('tells an OFFLINE driver it is offline and does not replay requests', async () => {
    const driverId = oidStr();
    vi.mocked(User.findById).mockReturnValue(slowQuery({ _id: driverId, isOnline: false }) as any);
    await startServer((srv) => initializeSocketIO(srv));

    client = connectRawClient(port, { userId: driverId, role: 'provider' });
    await client.connected;
    await wait(DB_DELAY_MS + 200);

    expect(client.eventsNamed('driver:status')).toEqual([{ isOnline: false }]);
    expect(client.eventsNamed('ride:pending-requests')).toEqual([]);
  });

  it('riders get no driver status events', async () => {
    const riderId = oidStr();
    vi.mocked(User.findById).mockReturnValue(mockQuery(null) as any);
    await startServer((srv) => initializeSocketIO(srv));

    client = connectRawClient(port, { userId: riderId, role: 'user' });
    await client.connected;
    await wait(150);

    expect(client.eventsNamed('driver:status')).toEqual([]);
    expect(await fakeRedis.sismember('users:online', riderId)).toBe(1);
  });
});
