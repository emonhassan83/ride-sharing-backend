import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const fromRoot = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Unit-test configuration for the Split Ride API.
 *
 * Tests live in `server/tests/` (mirroring `src/app/`) so they are NOT part of the
 * `tsc` build (`tsconfig.json` only includes `src`) nor of the Docker image.
 *
 * Hermeticity rules:
 *  - `dotenv` is aliased to a no-op stub, so the developer's real `.env` (DB URLs,
 *    Stripe keys, ...) is never read. All env vars the app needs are defined below.
 *  - Time zone is pinned to the production zone (Europe/Nicosia) for determinism.
 *  - Redis / logger / firebase are mocked globally in `tests/setup/global.setup.ts`.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^dotenv$/, replacement: fromRoot('./tests/stubs/dotenv.ts') },
      // Tests-only shorthand: `@src/app/utils/x` === `server/src/app/utils/x`.
      // (Mirrored in tsconfig.test.json `paths` for type-checking.)
      { find: /^@src\//, replacement: fromRoot('./src/') },
      { find: /^@tests\//, replacement: fromRoot('./tests/') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup/global.setup.ts'],
    // The app code is very chatty (console.log); only show output of failing tests.
    silent: 'passed-only',
    // Hermetic mocks: no call history / queued `...Once` values / spies leak between tests.
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    env: {
      NODE_ENV: 'test',
      TZ: 'Europe/Nicosia',
      TIME_ZONE: 'Europe/Nicosia',
      RIDE_TIME_ZONE: 'Europe/Nicosia',
      PORT: '5000',
      BACKEND_IP: '127.0.0.1',
      SERVER_URL: 'http://localhost:5000',
      CLIENT_URL: 'http://localhost:3000',
      JWT_ACCESS_SECRET: 'test-access-secret',
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      JWT_ACCESS_EXPIRATION_TIME: '1h',
      JWT_REFRESH_EXPIRATION_TIME: '7d',
      BCRYPT_SALT_ROUNDS: '4',
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6379',
      REDIS_TTL: '3600',
      MONGODB_URL: 'mongodb://127.0.0.1:27017/split-ride-test',
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
    coverage: {
      provider: 'v8',
      // Report on ALL source files (not only those a test happens to import) so the
      // number is honest about untested code.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/generated/**'],
      reporter: ['text-summary', 'text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
    },
  },
});
