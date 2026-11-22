/**
 * Test stub for `dotenv` (aliased in vitest.config.mts). Unit tests must never read the
 * developer's real `.env`; values come from `test.env` in vitest.config.mts instead.
 */
export const config = () => ({ parsed: {} as Record<string, string> });

export default { config };
