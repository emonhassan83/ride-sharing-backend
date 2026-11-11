import { TEnv } from '@/app/@types/system.types';
import { getEnv } from '@/app/utils/env.utils';

const resolveWorkerTimeZone = (raw?: string | null): string => {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (!cleaned) return 'Europe/Nicosia';
  const lower = cleaned.toLowerCase();
  if (lower === 'cyprus' || lower === 'nicosia' || lower === 'europe/nicosia') {
    return 'Europe/Nicosia';
  }
  if (lower === 'bangladesh' || lower === 'dhaka' || lower === 'asia/dhaka') {
    return 'Asia/Dhaka';
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: cleaned });
    return cleaned;
  } catch {
    return 'Europe/Nicosia';
  }
};

const activeWorkerTimeZone = resolveWorkerTimeZone(
  process.env.TIME_ZONE || getEnv('TIME_ZONE'),
);
process.env.TZ = activeWorkerTimeZone;

export const env: TEnv = {
  NODE_ENV: getEnv('NODE_ENV'),
  SMTP_HOST: getEnv('SMTP_HOST'),
  SMTP_PORT: Number(getEnv('SMTP_PORT')),
  SMTP_SECURE: process.env.SMTP_SECURE !== undefined
    ? process.env.SMTP_SECURE === 'true'
    : getEnv('SMTP_PORT') === '465',
  SMTP_USERNAME: getEnv('SMTP_USERNAME'),
  SMTP_PASSWORD: getEnv('SMTP_PASSWORD'),
  EMAIL_FROM: getEnv('EMAIL_FROM'),
  REDIS_HOST: getEnv('REDIS_HOST'),
  REDIS_PASSWORD: getEnv('REDIS_PASSWORD'),
  REDIS_PORT: Number(getEnv('REDIS_PORT')),
  S3_ACCESS_KEY: getEnv('S3_ACCESS_KEY'),
  S3_SECRET_KEY: getEnv('S3_SECRET_KEY'),
  S3_REGION: getEnv('S3_REGION'),
  S3_BUCKET_NAME: getEnv('S3_BUCKET_NAME'),
  timeZone: activeWorkerTimeZone,
  SERVER_URL: getEnv('SERVER_URL'),
};

