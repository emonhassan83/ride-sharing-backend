/**
 * Test stub for `dotenv` (aliased in vitest.config.ts).
 *
 * `src/app/config/env.config.ts` calls `dotenv.config({ path: .env })` at import time.
 * Unit tests must never read the developer's real `.env` (it contains live DB/Stripe
 * credentials), so this no-op replaces it. Environment values come from the `env`
 * block in vitest.config.ts instead.
 */
export const config = () => ({ parsed: {} as Record<string, string> });

export default { config };
