// configs/queue.config.ts
import { QueueOptions } from 'bullmq';

import { getRedisClient } from './redis.config';

export function createQueueOptions(): QueueOptions {
  return {
    connection: getRedisClient() as any, // Cast to any to satisfy BullMQ's expected type
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    },
  };
}
