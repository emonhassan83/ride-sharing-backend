import { createServer, Server } from 'http';
import colors from 'colors';
import mongoose from 'mongoose';
import app from './app';
import { errorLogger, logger } from './app/config/logger.config';
import { config } from './app/config/env.config';
import { connectRedis } from './app/config/redis.config';
import initializeSocketIO from './app/socket/socket.init';
import { startBackgroundJobs } from './app/job/jobScheduler';

// ✅ One server, created once, never reassigned
const server: Server = createServer(app);
export const io = initializeSocketIO(server);

async function main() {
  try {
    await connectRedis();
    console.log(colors.cyan.bold('✅ Redis Connected'));

    await mongoose.connect(config.database.mongoUrl as string);
    logger.info(colors.green('🚀 Database connected successfully'));

    const port =
      typeof config.port === 'number' ? config.port : Number(config.port);

    // ✅ server.listen() — NOT app.listen() — never reassign `server`
    server.listen(port, config.backend.ip as string, () => {
      logger.info(
        colors.yellow(
          `♻️  Application listening on port ${config.backend.baseUrl}`
        )
      );

      // Start cron jobs AFTER the server is fully listening —
      startBackgroundJobs();
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
