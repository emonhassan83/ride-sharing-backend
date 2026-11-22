/**
 * Unit tests: worker Redis singleton (`src/app/configs/redis.configs.ts`).
 * BullMQ requires `maxRetriesPerRequest: null` on its connection; `lazyConnect` lets the process
 * decide when to connect (index.ts connects BEFORE creating workers).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { RedisMock, instances } = vi.hoisted(() => ({
  RedisMock: vi.fn(),
  instances: [] as any[],
}));
vi.mock('ioredis', () => ({ Redis: RedisMock }));

beforeEach(() => {
  vi.resetModules();
  instances.length = 0;
  RedisMock.mockImplementation(function (this: any, options: any) {
    this.options = options;
    this.status = 'wait';
    this.handlers = {} as Record<string, (...a: any[]) => void>;
    this.on = vi.fn((event: string, fn: (...a: any[]) => void) => {
      this.handlers[event] = fn;
      return this;
    });
    this.connect = vi.fn(async () => {
      this.status = 'ready';
    });
    this.quit = vi.fn(async () => 'OK');
    instances.push(this);
  });
});

const load = () => import('@/app/configs/redis.configs');

describe('redis singleton', () => {
  it('getRedisClient throws until the client was initialised', async () => {
    const { getRedisClient } = await load();
    expect(() => getRedisClient()).toThrow('Redis client not initialized. Call connectRedis() first.');
  });

  it('creates ONE lazy client with BullMQ-compatible options from env', async () => {
    const { initializeRedis, getRedisClient } = await load();
    initializeRedis();
    initializeRedis(); // idempotent

    expect(RedisMock).toHaveBeenCalledTimes(1);
    expect(instances[0].options).toEqual({
      host: '127.0.0.1',
      password: 'redis-pass',
      port: 6379,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    expect(getRedisClient()).toBe(instances[0]);
  });

  it('falls back to port 6379 when REDIS_PORT is 0', async () => {
    vi.stubEnv('REDIS_PORT', '0');
    const { initializeRedis } = await load();
    initializeRedis();
    expect(instances[0].options.port).toBe(6379);
  });

  it('error events are logged, not thrown (a Redis blip must not crash the worker)', async () => {
    const { initializeRedis } = await load();
    initializeRedis();
    expect(() => instances[0].handlers.error(new Error('ECONNRESET'))).not.toThrow();
    expect(() => instances[0].handlers.ready()).not.toThrow();
  });

  describe('connectRedis', () => {
    it('connects a fresh (status "wait") client exactly once', async () => {
      const { connectRedis } = await load();
      await connectRedis();
      await connectRedis(); // now "ready": must not connect again

      expect(RedisMock).toHaveBeenCalledTimes(1);
      expect(instances[0].connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('disconnectRedis', () => {
    it('is a no-op when no client was ever created', async () => {
      const { disconnectRedis } = await load();
      await expect(disconnectRedis()).resolves.toBeUndefined();
      expect(RedisMock).not.toHaveBeenCalled();
    });

    it('quits a ready client (graceful shutdown)', async () => {
      const { connectRedis, disconnectRedis } = await load();
      await connectRedis();
      await disconnectRedis();
      expect(instances[0].quit).toHaveBeenCalledTimes(1);
    });

    it('does not quit a client that never became ready', async () => {
      const { initializeRedis, disconnectRedis } = await load();
      initializeRedis(); // status stays "wait"
      await disconnectRedis();
      expect(instances[0].quit).not.toHaveBeenCalled();
    });
  });
});
