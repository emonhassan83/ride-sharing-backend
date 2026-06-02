import 'dotenv/config';
import { Worker } from 'bullmq';
import { connectRedis, disconnectRedis } from '@/app/configs/redis.configs';
import { createEmailWorker } from '@/app/workers/email.workers';
import { logger } from './app/configs/logger.configs';
import { createNotificationWorker } from './app/workers/notification.workers';

// ─────────────────────────────────────────────────────────────
// Registry — add every new Worker instance here
// ─────────────────────────────────────────────────────────────
let allWorkers: Worker[] = [];
const TAG = '[Worker]';

// ─────────────────────────────────────────────────────────────
// Graceful shutdown
//
// On SIGTERM / SIGINT:
//   1. Stop each BullMQ worker (finishes in-flight jobs, stops polling)
//   2. Disconnect Redis
//   3. Exit 0
//
// dumb-init in Docker forwards the signal properly, so this fires
// even inside a container.
// ─────────────────────────────────────────────────────────────
let isShuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`${TAG} ${signal} received — draining workers`);

  try {
    // Close all workers (waits for active jobs to finish)
    await Promise.all(allWorkers.map((w) => w.close()));
    logger.info(`${TAG} All workers drained`);

    await disconnectRedis();
    logger.info(`${TAG} Redis disconnected`);

    logger.info(`${TAG} ✓ Clean shutdown`);
    process.exit(0);
  } catch (err) {
    logger.error(`${TAG} Error during shutdown`, { err });
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Log but don't exit — BullMQ handles job-level errors internally.
// If the error is unrecoverable the job will be marked failed and retried.
process.on('uncaughtException', (err) => {
  logger.error(`${TAG} Uncaught exception`, { err });
});

process.on('unhandledRejection', (reason) => {
  logger.error(`${TAG} Unhandled rejection`, { reason });
});

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────
const start = async (): Promise<void> => {
  logger.info(`${TAG} Starting — PID ${process.pid}`);

  // Redis must be connected before workers start polling
  await connectRedis();
  allWorkers = [
    createEmailWorker(),
    createNotificationWorker(), // Handles push + socket notifications
  ];
  logger.info(
    `${TAG} ${allWorkers.length} worker(s) active — listening for jobs`
  );
};

start().catch((err) => {
  logger.error(`${TAG} Failed to start`, { err });
  process.exit(1);
});
