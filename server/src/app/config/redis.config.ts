import { Redis } from 'ioredis';
import { config } from './env.config';

let redisClient: Redis | null = null;

export const initializeRedis = () => {
  if (!redisClient) {
    const redisConfig: any = {
      host: config.redis.host,
      port: Number(config.redis.port) || 6379,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    };

    if (config.redis.password && config.redis.password !== '') {
      redisConfig.password = config.redis.password;
    }

    redisClient = new Redis(redisConfig);

    redisClient.on('ready', () => {
      console.log('[Redis] Ready');
    });

    redisClient.on('error', (err) => {
      console.error('Redis connection error:', err);
    });
  }
};

export async function connectRedis() {
  initializeRedis();
  if (redisClient && redisClient.status === 'wait') {
    await redisClient.connect();
    console.info('[Redis] connected');
  }
}

export async function disconnectRedis() {
  if (redisClient && redisClient.status === 'ready') {
    console.info('[Redis] Disconnecting...');
    await redisClient.quit();
    console.info('[Redis] Disconnected');
  }
}

export function getRedisClient(): Redis {
  if (!redisClient) {
    throw new Error('Redis client not initialized. Call connectRedis() first.');
  }
  return redisClient;
}