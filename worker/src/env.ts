import { TEnv } from '@/app/@types/system.types';
import { getEnv } from '@/app/utils/env.utils';

export const env: TEnv = {
  NODE_ENV: getEnv('NODE_ENV'),
  SMTP_HOST: getEnv('SMTP_HOST'),
  SMTP_PORT: Number(getEnv('SMTP_PORT')),
  SMTP_USER: getEnv('SMTP_USER'),
  SMTP_PASS: getEnv('SMTP_PASS'),
  REDIS_HOST: getEnv('REDIS_HOST'),
  REDIS_PASSWORD: getEnv('REDIS_PASSWORD'),
  REDIS_PORT: Number(getEnv('REDIS_PORT')),
  S3_ACCESS_KEY: getEnv('S3_ACCESS_KEY'),
  S3_SECRET_KEY: getEnv('S3_SECRET_KEY'),
  S3_REGION: getEnv('S3_REGION'),
  S3_BUCKET_NAME: getEnv('S3_BUCKET_NAME'),
  timeZone: getEnv('TIME_ZONE'),
  SERVER_URL: getEnv('SERVER_URL'),
};
