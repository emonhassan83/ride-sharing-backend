import { createServer, Server } from 'http';
import colors from 'colors';
import mongoose from 'mongoose';
import app from './app';
import { errorLogger, logger } from './app/config/logger.config';
import { config } from './app/config/env.config';
import { connectRedis } from './app/config/redis.config';
import initializeSocketIO from './app/socket/socket.init';
import { startBackgroundJobs } from './app/job/jobScheduler';
import { syncVehicleIndexes } from './app/modules/vehicle/vehicle.model';
import { initChatPushWorker } from './app/queues/chatPush.queue';

// ✅ One server, created once, never reassigned
const server: Server = createServer(app);
export const io = initializeSocketIO(server);

async function main() {
  try {
    await connectRedis();
    console.log(colors.cyan.bold('✅ Redis Connected'));

    await mongoose.connect(config.database.mongoUrl as string);
    logger.info(colors.green('🚀 Database connected successfully'));

    await syncVehicleIndexes().catch((err) =>
      errorLogger.error(`Vehicle index sync failed: ${err?.message || err}`)
    );

    const port =
      typeof config.port === 'number' ? config.port : Number(config.port);

    // ✅ server.listen() — NOT app.listen() — never reassign `server`
    server.listen(port, config.backend.ip as string, () => {
      logger.info(
        colors.yellow(
          `♻️  Application listening on port ${config.backend.baseUrl}`
        )
      );

      // B-02: make a wrong NODE_ENV visible in the logs on every start.
      if (config.exposeDevSecrets) {
        logger.warn(
          colors.red.bold(
            `⚠️  NODE_ENV=${config.environment}: OTP codes are returned in API responses and SMS is mocked. Never expose this server publicly; set NODE_ENV=production.`
          )
        );
      } else if (config.environment !== 'production') {
        logger.warn(
          colors.yellow(
            `⚠️  NODE_ENV is "${config.environment ?? ''}" (not production). Running with production-safe OTP behaviour.`
          )
        );
      }

      // Start cron jobs & BullMQ chat push worker AFTER the server is fully listening —
      startBackgroundJobs();
      initChatPushWorker();
    });

    // @ts-ignore
    global.socketio = io;
  } catch (error) {
    console.log(error);
    errorLogger.error(colors.red('🤢 Failed to connect Database'));
  }
}

main();

process.on('unhandledRejection', (err) => {
  console.log(`😈 unhandledRejection is detected , shutting down ...`, err);
  errorLogger.error(err);
  if (server) {
    server.close(() => {
      process.exit(1);
    });
  }
  process.exit(1);
});

process.on('uncaughtException', () => {
  console.log(`😈 uncaughtException is detected , shutting down ...`);
  errorLogger.error('uncaughtException is detected');
  process.exit(1);
});
