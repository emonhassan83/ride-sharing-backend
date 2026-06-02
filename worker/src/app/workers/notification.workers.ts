// server/src/workers/notification.worker.ts
import { Job, Worker } from 'bullmq';
import { getRedisClient } from '@/app/configs/redis.configs';
import { requestContext } from '@/app/configs/requestContext.configs';
import { logger } from '../configs/logger.configs';
import { sendPushNotification } from '../utils/push-notification.service';
import { sendSocketNotification } from '../utils/socket-notification.service';

export const createNotificationWorker = (): Worker => {
  const NotificationWorker = new Worker(
    'notification-queue',
    async (job: Job) => {
      const { id, name, data } = job;
      const traceId = data?.metadata?.traceId ?? 'NO_TRACE_ID';

      return requestContext.run({ traceId }, async () => {
        try {
          const { userId, type, title, message, data: extraData } = data;

          logger.info(
            `🔔 Processing notification | JobId: ${id} | Type: ${type} | UserId: ${userId}`
          );

          const results: any = {};

          // Handle based on type
          switch (type) {
            case 'PUSH': {
              results.push = await sendPushNotification(userId, {
                title,
                body: message,
                data: extraData,
              });
              break;
            }

            case 'SOCKET': {
              results.socket = await sendSocketNotification(userId, {
                type: extraData?.notificationType || 'GENERAL',
                title,
                message,
                data: extraData,
              });
              break;
            }

            case 'BOTH': {
              const [pushResult, socketResult] = await Promise.all([
                sendPushNotification(userId, {
                  title,
                  body: message,
                  data: extraData,
                }),
                sendSocketNotification(userId, {
                  type: extraData?.notificationType || 'GENERAL',
                  title,
                  message,
                  data: extraData,
                }),
              ]);
              results.push = pushResult;
              results.socket = socketResult;
              break;
            }

            default: {
              logger.warn(`Unknown notification type: ${type}`);
              break;
            }
          }

          logger.info(`✅ Notification sent | JobId: ${id} | Type: ${type}`);
          return { success: true, jobName: name, results };
        } catch (error) {
          logger.error('Notification Worker failed', {
            jobName: name,
            jobId: id,
            error: error instanceof Error ? error.message : error,
          });
          throw error;
        }
      });
    },
    {
      connection: getRedisClient() as any,
      concurrency: 10,
      limiter: {
        max: 100,
        duration: 1000,
      },
    }
  );

  // Event Handlers
  NotificationWorker.on('completed', (job: Job) => {
    const traceId = job.data?.metadata?.traceId ?? 'NO_TRACE_ID';
    requestContext.run({ traceId }, () => {
      logger.info(`✅ Notification Job Completed | ID: ${job.id}`);
    });
  });

  NotificationWorker.on('failed', (job: Job | undefined, error: Error) => {
    if (!job) {
      logger.error(`Notification job failed. Error: ${error}`);
      return;
    }
    const traceId = job.data?.metadata?.traceId ?? 'NO_TRACE_ID';
    requestContext.run({ traceId }, () => {
      logger.error(
        `❌ Notification Job Failed | ID: ${job.id}\nError: ${error.message}`
      );
    });
  });

  return NotificationWorker;
};
