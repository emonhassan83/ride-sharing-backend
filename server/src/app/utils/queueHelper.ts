// server/src/utils/queueHelper.ts
import { Queue } from 'bullmq';
import { getEmailQueue } from '../queues/email.queues';

let emailQueueInstance: Queue | null = null;

export const getEmailQueueInstance = async () => {
  if (!emailQueueInstance) {
    emailQueueInstance = await getEmailQueue();
  }
  return emailQueueInstance;
};

// Optional: Queue reset function
export const resetEmailQueueInstance = () => {
  emailQueueInstance = null;
};