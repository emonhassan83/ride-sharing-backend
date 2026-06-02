import { env } from '@/env';
import path from 'path';
import DailyRotateFile from 'winston-daily-rotate-file';
import { createLogger, format, transports } from 'winston';
const { combine, timestamp, label, printf } = format;

const TIME_ZONE = env.timeZone || 'Asia/Dhaka';

const myFormat = printf((info) => {
  const { level, message, label, timestamp } = info;
  // Convert UTC timestamp to Asia/Dhaka time zone for display
  const date = new Date(String(timestamp));
  const options: Intl.DateTimeFormatOptions = {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  };

  const formattedDate = date.toLocaleString('en-US', options);

  return `${formattedDate} [${label}] ${level}: ${message}`;
});

const logger = createLogger({
  level: 'info',
  format: combine(label({ label: 'SERVER-NAME' }), timestamp(), myFormat),
  transports: [
    new transports.Console(),
    new DailyRotateFile({
      filename: path.join(
        process.cwd(),
        'winston',
        'success',
        '%DATE%-success.log'
      ),
      datePattern: 'DD-MM-YYYY-HH',
      maxSize: '20m',
      maxFiles: '1d',
    }),
  ],
});

const errorLogger = createLogger({
  level: 'error',
  format: combine(label({ label: 'Lock Smit' }), timestamp(), myFormat),
  transports: [
    new transports.Console(),
    new DailyRotateFile({
      filename: path.join(
        process.cwd(),
        'winston',
        'error',
        '%DATE%-error.log'
      ),
      datePattern: 'DD-MM-YYYY-HH',
      maxSize: '20m',
      maxFiles: '1d',
    }),
  ],
});

export { errorLogger, logger };
