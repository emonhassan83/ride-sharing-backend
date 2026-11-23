import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const fromRoot = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Integration tests against REAL MongoDB and Redis (throwaway Docker containers),
 * the real Express app, the real Socket.io server and the real BullMQ chat worker.
 * Only third-party services are faked: Firebase (push), Google Maps, Stripe, Twilio, SMTP.
 *
 * Start the services first (ports chosen not to clash with a dev stack):
 *   docker run -d --name splitride-it-mongo -p 27099:27017 mongo:latest
 *   docker run -d --name splitride-it-redis -p 6399:6379 redis:7-alpine
 * Then: npm run test:integration
 *
 * The developer's .env is NEVER read (dotenv is stubbed), so these tests can not touch
 * the shared Atlas database or production Redis.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^dotenv$/, replacement: fromRoot('./tests/stubs/dotenv.ts') },
      { find: /^@src\//, replacement: fromRoot('./src/') },
      { find: /^@tests\//, replacement: fromRoot('./tests/') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.int.test.ts'],
    setupFiles: ['./tests/integration/setup.ts'],
    fileParallelism: false, // one shared database
    silent: 'passed-only',
    clearMocks: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      TZ: 'Europe/Nicosia',
      TIME_ZONE: 'Europe/Nicosia',
      RIDE_TIME_ZONE: 'Europe/Nicosia',
      PORT: '5000',
      BACKEND_IP: '127.0.0.1',
      SERVER_URL: 'http://localhost:5000',
      CLIENT_URL: 'http://localhost:3000',
      JWT_ACCESS_SECRET: 'it-access-secret',
      JWT_REFRESH_SECRET: 'it-refresh-secret',
      JWT_ACCESS_EXPIRATION_TIME: '1h',
      JWT_REFRESH_EXPIRATION_TIME: '7d',
      BCRYPT_SALT_ROUNDS: '4',
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      MONGODB_URL: process.env.IT_MONGODB_URL || 'mongodb://127.0.0.1:27099/splitride-it',
      REDIS_HOST: process.env.IT_REDIS_HOST || '127.0.0.1',
      REDIS_PORT: process.env.IT_REDIS_PORT || '6399',
      REDIS_PASSWORD: '',
      REDIS_TTL: '3600',
      SMTP_HOST: 'smtp.test.local',
      SMTP_PORT: '587',
      SMTP_USERNAME: 'test',
      SMTP_PASSWORD: 'test',
      EMAIL_FROM: 'no-reply@test.local',
      GOOGLE_MAPS_API_KEY: 'test-maps-key',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'test-token',
      TWILIO_PHONE_NUMBER: '+10000000000',
    },
  },
});
