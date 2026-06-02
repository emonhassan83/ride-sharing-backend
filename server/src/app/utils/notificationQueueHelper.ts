// server/src/utils/notificationQueueHelper.ts
import { Queue } from 'bullmq';
import { getNotificationQueue } from '../queues/notification.queues';

let notificationQueueInstance: Queue | null = null;

export const getNotificationQueueInstance = async () => {
  if (!notificationQueueInstance) {
    notificationQueueInstance = await getNotificationQueue();
  }
  return notificationQueueInstance;
};