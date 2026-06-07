// workers/notification.worker.ts
import { Job, Worker } from 'bullmq';
import { getRedisClient } from '../configs/redis.configs';
import { sendPushNotification } from '../utils/push-notification.service';

export const createNotificationWorker = (): Worker => {
  const worker = new Worker(
    'notification-queue',
    async (job: Job) => {
      const { id, name, data } = job;

      try {
        const { userId, title, message, data: extraData } = data;

        console.log(`🔔 Processing notification | JobId: ${id} | UserId: ${userId}`);

        const result = await sendPushNotification(userId, {
          title,
          body:  message,
          data:  extraData
            ? Object.fromEntries(
                Object.entries(extraData).map(([k, v]) => [k, String(v)]),
              )
            : {},
        });

        console.log(`✅ Notification sent | JobId: ${id} | Success: ${result.success}`);
        return { success: true, jobName: name, result };
      } catch (error) {
        console.error(`❌ Notification worker failed | JobId: ${id}`, error);
        throw error;
      }
    },
    {
      connection:  getRedisClient() as any,
      concurrency: 10,
      limiter:     { max: 100, duration: 1000 },
    },
  );

  worker.on('completed', (job: Job) => {
    console.log(`✅ Notification job completed | ID: ${job.id}`);
  });

  worker.on('failed', (job: Job | undefined, error: Error) => {
    console.error(`❌ Notification job failed | ID: ${job?.id} | Error: ${error.message}`);
  });

  return worker;
};