/**
 * Fakes for Socket.io `Server` (io) and `Socket`, used by socket handler tests.
 *
 * `createMockIo()` records every emission as `{ rooms, event, payload }` so tests assert
 * on WHO was told WHAT:
 *
 *     expect(io.emittedTo('user:123', 'ride:cancelled')).toHaveLength(1);
 *
 * `createMockSocket()` mimics an authenticated TSocket (`socket.auth` is what
 * `socketAuth` attaches in production).
 */
import { vi } from 'vitest';
import { oidStr } from './mongoose';

export interface EmitRecord {
  /** Rooms targeted via `.to()` / `.in()`. Empty array = broadcast. */
  rooms: string[];
  event: string;
  payload: unknown[];
}

const toArray = (r: string | string[]): string[] => (Array.isArray(r) ? r : [r]);

export function createMockIo() {
  const emitted: EmitRecord[] = [];

  const makeOp = (rooms: string[]): any => {
    const op: any = {
      to: vi.fn((room: string | string[]) => makeOp([...rooms, ...toArray(room)])),
      in: vi.fn((room: string | string[]) => makeOp([...rooms, ...toArray(room)])),
      except: vi.fn(() => op),
      emit: vi.fn((event: string, ...payload: unknown[]) => {
        emitted.push({ rooms, event, payload });
        return true;
      }),
      fetchSockets: vi.fn(async () => []),
    };
    return op;
  };

  const io: any = {
    emitted,
    to: vi.fn((room: string | string[]) => makeOp(toArray(room))),
    in: vi.fn((room: string | string[]) => makeOp(toArray(room))),
    emit: vi.fn((event: string, ...payload: unknown[]) => {
      emitted.push({ rooms: [], event, payload });
      return true;
    }),
    sockets: {
      adapter: { rooms: new Map<string, Set<string>>() },
      sockets: new Map<string, any>(),
    },
    socketsJoin: vi.fn(),
    socketsLeave: vi.fn(),
    fetchSockets: vi.fn(async () => []),

    /** All emissions to a room (optionally filtered by event). */
    emittedTo(room: string, event?: string): EmitRecord[] {
      return emitted.filter(
        (e) => e.rooms.includes(room) && (event === undefined || e.event === event),
      );
    },
    /** All emissions of an event regardless of room. */
    emittedEvents(event: string): EmitRecord[] {
      return emitted.filter((e) => e.event === event);
    },
    /** Payload (first arg) of the single emission of `event` to `room`. */
    payloadTo(room: string, event: string): any {
      const hits = io.emittedTo(room, event);
      return hits.length ? hits[hits.length - 1].payload[0] : undefined;
    },
  };
  return io;
}

export type MockIo = ReturnType<typeof createMockIo>;

export interface MockSocketOptions {
  userId?: string;
  role?: 'user' | 'provider' | 'admin';
  language?: string;
  auth?: Record<string, any>;
  handshake?: Record<string, any>;
}

export function createMockSocket(opts: MockSocketOptions = {}) {
  const userId = opts.userId ?? oidStr();
  const auth = {
    _id: userId,
    email: `${userId}@test.local`,
    role: opts.role ?? 'user',
    name: 'Test User',
    phone: '+35799000000',
    language: opts.language ?? 'en',
    ...opts.auth,
  };
  const listeners = new Map<string, (...args: any[]) => any>();
  const socket: any = {
    id: `sock-${userId.slice(-6)}`,
    auth,
    data: { user: auth },
    handshake: { auth: {}, headers: {}, ...opts.handshake },
    rooms: new Set<string>(),
    emit: vi.fn(),
    join: vi.fn(function (this: any, room: string) {
      socket.rooms.add(room);
    }),
    leave: vi.fn(function (this: any, room: string) {
      socket.rooms.delete(room);
    }),
    disconnect: vi.fn(),
    on: vi.fn((event: string, fn: (...args: any[]) => any) => {
      listeners.set(event, fn);
      return socket;
    }),
    to: vi.fn(() => ({ emit: vi.fn() })),
    broadcast: { to: vi.fn(() => ({ emit: vi.fn() })), emit: vi.fn() },
    /** Test helper: events emitted straight to this socket. */
    emittedEvent(event: string): any[][] {
      return socket.emit.mock.calls.filter((c: any[]) => c[0] === event);
    },
    /** Test helper: fire a registered `socket.on(event, ...)` listener. */
    async trigger(event: string, ...args: any[]) {
      const fn = listeners.get(event);
      if (!fn) throw new Error(`No listener registered for "${event}"`);
      return fn.call(socket, ...args);
    },
    listeners,
  };
  return socket;
}

export type MockSocket = ReturnType<typeof createMockSocket>;
