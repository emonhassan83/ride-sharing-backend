export type TEnv = {
  NODE_ENV: string;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_USER: string;
  SMTP_PASS: string;
  REDIS_HOST: string;
  REDIS_PASSWORD: string;
  REDIS_PORT: number;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_REGION: string;
  S3_BUCKET_NAME: string;
  timeZone: string
};

export type ISendEmail = {
  to: string;
  subject: string;
  html: string;
};
