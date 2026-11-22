import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const fromRoot = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Unit-test configuration for the BullMQ worker (emails + push notifications).
 *
 * Mirrors server/vitest.config.mts: tests live in `worker/tests/` (outside `src`, so the
 * `tsc` build / Docker image never see them), `dotenv` is stubbed so the real `.env` is never
 * read, every variable `src/env.ts` demands is defined below, and mocks never leak between tests.
 *
 * Why Vitest 3.2 and not 5.x: see server/tests/README.md (5.1.1 breaks when the shell cwd has a
 * lower-case drive letter on Windows).
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^dotenv\/config$/, replacement: fromRoot('./tests/stubs/empty.ts') },
      { find: /^dotenv$/, replacement: fromRoot('./tests/stubs/dotenv.ts') },
      // The worker source uses `@/` for `src/` (tsconfig paths); tests use `@tests/`.
      { find: /^@\//, replacement: fromRoot('./src/') },
      { find: /^@tests\//, replacement: fromRoot('./tests/') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup/global.setup.ts'],
    silent: 'passed-only',
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
      SMTP_HOST: 'smtp.test.local',
      SMTP_PORT: '587',
      SMTP_USERNAME: 'smtp-user',
      SMTP_PASSWORD: 'smtp-pass',
      EMAIL_FROM: 'no-reply@test.local',
      REDIS_HOST: '127.0.0.1',
      REDIS_PASSWORD: 'redis-pass',
      REDIS_PORT: '6379',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'secret',
      S3_REGION: 'eu-central-1',
      S3_BUCKET_NAME: 'bucket',
      SERVER_URL: 'http://server.test:8080/api/v1',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
    },
  },
});
