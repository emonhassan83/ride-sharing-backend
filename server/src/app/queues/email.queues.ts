import { Queue } from 'bullmq';

import { createQueueOptions } from '../config/queue.configs';

let _emailQueue: Queue | null = null;

export const getEmailQueue = () => {
  if (!_emailQueue) {
    _emailQueue = new Queue('email-queue', createQueueOptions());
  }
  return _emailQueue;
};

