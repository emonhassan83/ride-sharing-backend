/**
 * Fake Stripe SDK instance. The app creates Stripe clients with `new Stripe(key, opts)`
 * at MODULE scope (payment.service, payment.utils, jobs) and via config/stripe.config, so
 * the module must be mocked before the service is imported.
 *
 * Usage (every `new Stripe()` anywhere returns the SAME shared instance, so the test can
 * configure the behaviour the service will see):
 *
 *   vi.mock('stripe', async () => {
 *     const { createStripeMock } = await import('@tests/helpers/stripeMock');
 *     const instance = createStripeMock();
 *     return { default: vi.fn(function () { return instance; }) };
 *   });
 *   import Stripe from 'stripe';
 *   const stripe = new (Stripe as any)('sk_test') as StripeMock;
 *
 *   stripe.paymentIntents.capture.mockResolvedValue({ id: 'pi_1', status: 'succeeded' });
 *
 * All methods are bare `vi.fn()`s; with `mockReset: true` (vitest.config.mts) they are reset
 * before each test, so every test states the Stripe responses it relies on.
 */
import { vi } from 'vitest';

const fn = () => vi.fn();

export function createStripeMock() {
  return {
    paymentIntents: {
      create: fn(),
      retrieve: fn(),
      update: fn(),
      capture: fn(),
      cancel: fn(),
      confirm: fn(),
      list: fn(),
    },
    refunds: { create: fn(), retrieve: fn(), list: fn() },
    customers: { create: fn(), retrieve: fn(), update: fn(), del: fn(), list: fn() },
    paymentMethods: { attach: fn(), detach: fn(), list: fn(), retrieve: fn(), update: fn() },
    setupIntents: { create: fn(), retrieve: fn(), confirm: fn() },
    accounts: { create: fn(), retrieve: fn(), update: fn(), del: fn() },
    accountLinks: { create: fn() },
    transfers: { create: fn(), list: fn(), retrieve: fn() },
    balance: { retrieve: fn() },
    charges: { retrieve: fn(), list: fn() },
    checkout: { sessions: { create: fn(), retrieve: fn() } },
    webhooks: { constructEvent: fn() },
  };
}

export type StripeMock = ReturnType<typeof createStripeMock>;
