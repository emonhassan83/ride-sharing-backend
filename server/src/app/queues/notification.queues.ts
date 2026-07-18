// server/src/queues/notification.queue.ts
import { Queue } from 'bullmq';
import { logger } from '../config/logger.config';
import { getRedisClient } from '../config/redis.config';

export interface NotificationJobData {
  userId: string;
  fcmToken: string;
  title: string;
  message: string;
  data?: any;
  priority?: 1 | 2 | 3 | 4 | 5;
  metadata?: {
    traceId?: string;
    source?: string;
    timestamp?: Date;
  };
}

let notificationQueueInstance: Queue | null = null;

export const getNotificationQueue = async (): Promise<Queue> => {
  if (!notificationQueueInstance) {
    notificationQueueInstance = new Queue('notification-queue', {
      connection: getRedisClient() as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
    logger.info('✅ Notification Queue initialized');
  }
  return notificationQueueInstance;
};

// Helper function to add notification job
export const addNotificationJob = async (
  data: NotificationJobData,
  traceId?: string
): Promise<string | undefined> => {
  const queue = await getNotificationQueue();

  const job = await queue.add(
    'send-notification',
    {
      ...data,
      metadata: {
        ...data.metadata,
        traceId: traceId || 'NO_TRACE_ID',
        timestamp: new Date(),
      },
    },
    {
      priority: data.priority || 3,
      jobId: `notif_${data.userId}_${Date.now()}`, // Fixed jobId
    }
  );
  
  logger.info(`📨 Notification job added | JobId: ${job.id} | User: ${data.userId}`);

  return job.id;
};