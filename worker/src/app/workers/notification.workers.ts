// workers/notification.worker.ts
import axios from 'axios';
import { Job, Worker } from 'bullmq';
import { env } from '@/env';
import { logger } from '../configs/logger.configs';
import { getRedisClient } from '../configs/redis.configs';
import { requestContext } from '../configs/requestContext.configs';
import { sendPushNotification } from '../utils/push-notification.service';

const SERVER_API_BASE = env.SERVER_URL;

export const createNotificationWorker = (): Worker => {
  const worker = new Worker(
    'notification-queue',
    async (job: Job) => {
      const { id, name, data } = job;
      const traceId = (job.data as any)?.traceId ?? 'NO_TRACE_ID';

      return requestContext.run({ traceId }, async () => {
        try {
          const { userId, title, message, fcmToken, data: extraData } = data;

          if (!fcmToken) {
            logger.warn(`⚠️ No FCM token for user ${userId}`);
            return { success: false };
          }

          // 1. Send Push Notification
          const pushResult = await sendPushNotification({
            fcmToken,
            title: title || 'SplitRide',
            body: message,
            data: extraData || {},
          });

          // 2. Save Notification to Database via Server API
          if (pushResult.success) {
            try {
              // TODO: Import the model(USER, NOTIFICATION, CHAT)
              await axios.post(`${SERVER_API_BASE}/notifications`, {
                receiver: userId,
                message: title,
                description: message,
                modelType: extraData?.modelType || 'GENERAL',
                reference: extraData?.reference || null,
                isRead: false,
              }, {
                headers: { 
                  'x-trace-id': traceId,
                  'Content-Type': 'application/json'
                }
              });

              logger.info(`💾 Notification saved via API | User: ${userId}`);
            } catch (saveError) {
              logger.error('Failed to save notification to DB', saveError);
              // Don't fail the job just because DB save failed
            }
          }

          return { success: true };

        } catch (error: any) {
          logger.error(`❌ Notification worker failed | JobId: ${id}`, error);
          throw error;
        }
      });
    },
    {
      connection: getRedisClient() as any,
      concurrency: 15,
    }
  );

  // Event Listeners...
  worker.on('completed', (job) => logger.info(`✅ Notification Completed | ${job.id}`));
  worker.on('failed', (job, err) => logger.error(`❌ Notification Failed | ${job?.id}`, err));

  return worker;
};