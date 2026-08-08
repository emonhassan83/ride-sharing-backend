import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join((process.cwd(), '.env')) });

export const config = {
  environment: process.env.NODE_ENV,
  port: process.env.PORT,
  socketPort: process.env.SOCKET,

  redis: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD,
    ttl: Number(process.env.REDIS_TTL),
    url:
      process.env.REDIS_URL ||
      `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
  },

  database: {
    mongoUrl: process.env.MONGODB_URL,
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiration: process.env.JWT_ACCESS_EXPIRATION_TIME,
    refreshExpiration: process.env.JWT_REFRESH_EXPIRATION_TIME,
  },

  admin_pass: process.env.ADMIN_PASS,

  bcrypt: {
    saltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS as string),
  },

  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT as string),
    secure:
      process.env.SMTP_SECURE !== undefined
        ? process.env.SMTP_SECURE === 'true'
        : process.env.SMTP_PORT === '465',
    username: process.env.SMTP_USERNAME,
    password: process.env.SMTP_PASSWORD,
    emailFrom: process.env.EMAIL_FROM,
  },

  client: {
    url: process.env.CLIENT_URL,
  },
  server: {
    url: process.env.SERVER_URL,
  },

  backend: {
    ip: process.env.BACKEND_IP,
    baseUrl: `http://${process.env.BACKEND_IP}:${process.env.PORT}`,
  },

  pay: {
    secretKey: process.env.STRIPE_SECRET_KEY
  },

  firebase: {
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
  },

  aws: {
    accessKeyId: process.env.S3_BUCKET_ACCESS_KEY,
    secretAccessKey: process.env.S3_BUCKET_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
    bucket: process.env.AWS_BUCKET_NAME,
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER,
  },

  timeZone: process.env.TIME_ZONE,
  google_maps_key: process.env.GOOGLE_MAPS_API_KEY,
};

