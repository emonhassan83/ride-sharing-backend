/**
 * Unit tests: waiting-time pricing and waiting-charge deduction.
 *
 * Rate: hourly setting (default day €17 / night €19) -> per-minute, rounded to 4 dp.
 * Charge: first 2 minutes are free (grace), the rest billed per minute, rounded to cents.
 * Deduction: wallet first, remainder on the rider's default Stripe payment method.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockQuery } from '@tests/helpers/mongoose';
import {
  calculateWaitingCharge,
  deductWaitingCharge,
  getWaitingRatePerMinute,
  isNightFare,
} from '@src/app/utils/waitingCharge.utils';
import { Setting } from '@src/app/modules/settings/settings.model';
import { User } from '@src/app/modules/user/user.model';

vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
});

vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});

// Stripe client: plain getter (not vi.fn) so mockReset cannot strip it.
const stripe = vi.hoisted(() => ({
  customers: { retrieve: vi.fn() },
  paymentIntents: { create: vi.fn() },
}));

vi.mock('@src/app/config/stripe.config', () => ({
  default: { getStripe: () => stripe },
}));

const at = (iso: string) => new Date(iso);

describe('getWaitingRatePerMinute', () => {
  it('uses the day hourly setting and converts it to a 4dp per-minute rate', async () => {
    vi.mocked(Setting.findOne).mockReturnValue(mockQuery({ key: 'dayFareWaitingCharge', value: 17 }) as any);
    // 17 / 60 = 0.283333... -> 0.2833
    expect(await getWaitingRatePerMinute(false)).toBe(0.2833);
    expect(Setting.findOne).toHaveBeenCalledWith({ key: 'dayFareWaitingCharge' });
  });

  it('uses the night setting key when isNight is true', async () => {
    vi.mocked(Setting.findOne).mockReturnValue(mockQuery({ key: 'nightFareWaitingCharge', value: 19 }) as any);
    // 19 / 60 = 0.316666... -> 0.3167
    expect(await getWaitingRatePerMinute(true)).toBe(0.3167);
    expect(Setting.findOne).toHaveBeenCalledWith({ key: 'nightFareWaitingCharge' });
  });

  it('falls back to the day default (17/h) when no setting document exists', async () => {
    vi.mocked(Setting.findOne).mockReturnValue(mockQuery(null) as any);
    expect(await getWaitingRatePerMinute()).toBe(0.2833);
  });

  it('falls back to the night default (19/h) when no setting document exists', async () => {
    vi.mocked(Setting.findOne).mockReturnValue(mockQuery(null) as any);
    expect(await getWaitingRatePerMinute(true)).toBe(0.3167);
  });

  it('falls back to the default when the stored value is null', async () => {
    vi.mocked(Setting.findOne).mockReturnValue(mockQuery({ value: null }) as any);
    expect(await getWaitingRatePerMinute(false)).toBe(0.2833);
  });

  it('coerces a numeric-string setting value', async () => {
    vi.mocked(Setting.findOne).mockReturnValue(mockQuery({ value: '30' }) as any);
    // 30 / 60 = 0.5 exactly
    expect(await getWaitingRatePerMinute(false)).toBe(0.5);
  });

  it('returns 0 when the stored hourly value is 0 (zero is not a missing value)', async () => {
    vi.mocked(Setting.findOne).mockReturnValue(mockQuery({ value: 0 }) as any);
    expect(await getWaitingRatePerMinute(false)).toBe(0);
  });
});

describe('isNightFare', () => {
  it('is false for a 06:00 departure (day starts)', () => {
    expect(isNightFare('06:00')).toBe(false);
  });

  it('is false for 20:29:59 (last day second)', () => {
    expect(isNightFare('20:29:59')).toBe(false);
  });

  it('is true for 20:30 (night starts)', () => {
    expect(isNightFare('20:30')).toBe(true);
  });

  it('is true for 05:59:59 (last night second)', () => {
    expect(isNightFare('05:59:59')).toBe(true);
  });
});

describe('calculateWaitingCharge', () => {
  const start = at('2026-06-01T10:00:00Z');
  const rate = 0.5; // €0.50 per billable minute

  it('charges nothing when pickup happens within the 2-minute grace period', () => {
    expect(calculateWaitingCharge(start, at('2026-06-01T10:01:00Z'), rate)).toBe(0);
  });

  it('charges nothing at exactly the grace boundary (2 minutes)', () => {
    expect(calculateWaitingCharge(start, at('2026-06-01T10:02:00Z'), rate)).toBe(0);
  });

  it('bills the first minute beyond the grace period (3 minutes total -> 1 billable)', () => {
    expect(calculateWaitingCharge(start, at('2026-06-01T10:03:00Z'), rate)).toBe(0.5);
  });

  it('bills 8 billable minutes for 10 minutes of waiting', () => {
    expect(calculateWaitingCharge(start, at('2026-06-01T10:10:00Z'), rate)).toBe(4);
  });

  it('returns 0 when pickup is before the waiting start (negative duration)', () => {
    expect(calculateWaitingCharge(start, at('2026-06-01T09:00:00Z'), rate)).toBe(0);
  });

  it('returns 0 when the start and pickup are identical', () => {
    expect(calculateWaitingCharge(start, start, rate)).toBe(0);
  });

  it('rounds the product to exact cents (7 billable min at 0.2833/min = 1.98)', () => {
    // 7 * 0.2833 = 1.9831 -> 1.98
    expect(calculateWaitingCharge(start, at('2026-06-01T10:09:00Z'), 0.2833)).toBe(1.98);
  });

  it('rounds to the nearest cent (3 billable min at 0.1667 = 0.50)', () => {
    // 3 * 0.1667 = 0.5001 -> 0.50
    expect(calculateWaitingCharge(start, at('2026-06-01T10:05:00Z'), 0.1667)).toBe(0.5);
  });

  it('honours a custom grace period (0 minutes bills from the first minute)', () => {
    expect(calculateWaitingCharge(start, at('2026-06-01T10:02:00Z'), rate, 0)).toBe(1);
  });

  it('CHARACTERIZATION: an invalid (unparseable) pickup date yields NaN rather than throwing', () => {
    // Surprising: no guard on invalid dates. Callers pass Date objects from Mongo, so this is latent.
    expect(calculateWaitingCharge(start, new Date('not-a-date'), rate)).toBeNaN();
  });
});

describe('deductWaitingCharge', () => {
  const userId = '665f00000000000000000001';
  const rideId = 'ride-1';

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('does nothing for a zero amount (no DB lookup)', async () => {
    expect(await deductWaitingCharge(userId, 0, rideId)).toEqual({ method: 'none', amount: 0 });
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('does nothing for a negative amount', async () => {
    expect(await deductWaitingCharge(userId, -5, rideId)).toEqual({ method: 'none', amount: 0 });
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('returns none when the user does not exist (no wallet change, no charge)', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery(null) as any);
    expect(await deductWaitingCharge(userId, 10, rideId)).toEqual({ method: 'none', amount: 0 });
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('debits the wallet in full when balance exceeds the amount', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 50, customerId: 'cus_1' }) as any);
    expect(await deductWaitingCharge(userId, 10.5, rideId)).toEqual({ method: 'wallet', amount: 10.5 });
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(userId, { $inc: { wallet: -10.5 } });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('uses only the wallet when balance equals the amount exactly (boundary)', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 10 }) as any);
    expect(await deductWaitingCharge(userId, 10, rideId)).toEqual({ method: 'wallet', amount: 10 });
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(userId, { $inc: { wallet: -10 } });
  });

  it('splits between wallet and the default card for a partial wallet balance', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 4, customerId: 'cus_1' }) as any);
    stripe.customers.retrieve.mockResolvedValue({
      invoice_settings: { default_payment_method: 'pm_1' },
    });
    stripe.paymentIntents.create.mockResolvedValue({ id: 'pi_1' });

    expect(await deductWaitingCharge(userId, 10, rideId)).toEqual({ method: 'wallet+card', amount: 10 });
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(userId, { $inc: { wallet: -4 } });
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith({
      amount: 600, // €6.00 card portion in cents
      currency: 'eur',
      customer: 'cus_1',
      payment_method: 'pm_1',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { rideId, type: 'waiting_charge' },
    });
  });

  it('charges the full amount to the card when the wallet is empty (method "card")', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 0, customerId: 'cus_1' }) as any);
    stripe.customers.retrieve.mockResolvedValue({
      invoice_settings: { default_payment_method: 'pm_1' },
    });
    stripe.paymentIntents.create.mockResolvedValue({ id: 'pi_2' });

    expect(await deductWaitingCharge(userId, 12.34, rideId)).toEqual({ method: 'card', amount: 12.34 });
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(vi.mocked(stripe.paymentIntents.create).mock.calls[0][0].amount).toBe(1234);
  });

  it('skips the card charge when the customer has no default payment method', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 0, customerId: 'cus_1' }) as any);
    stripe.customers.retrieve.mockResolvedValue({ invoice_settings: {} });

    expect(await deductWaitingCharge(userId, 5, rideId)).toEqual({ method: 'card', amount: 5 });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('logs and swallows a Stripe failure instead of throwing', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 0, customerId: 'cus_1' }) as any);
    stripe.customers.retrieve.mockRejectedValue(new Error('stripe down'));

    await expect(deductWaitingCharge(userId, 5, rideId)).resolves.toEqual({ method: 'card', amount: 5 });
    expect(console.error).toHaveBeenCalledWith(
      'Card charge failed for waiting charge:',
      expect.any(Error),
    );
  });

  it('CHARACTERIZATION: a negative stored wallet is treated as a card-only charge for the full amount plus the deficit', async () => {
    // wallet -3, amount 10: walletBalance < amount so the partial branch runs, walletPortion is
    // negative (not debited), and the card portion becomes 13. Surprising; wallets should not go negative.
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: -3, customerId: 'cus_1' }) as any);
    stripe.customers.retrieve.mockResolvedValue({
      invoice_settings: { default_payment_method: 'pm_1' },
    });
    stripe.paymentIntents.create.mockResolvedValue({ id: 'pi_3' });

    await deductWaitingCharge(userId, 10, rideId);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(vi.mocked(stripe.paymentIntents.create).mock.calls[0][0].amount).toBe(1300);
  });

});

describe('KNOWN BUGS - waitingCharge.utils', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  // BUG-REPORT FARE-01 | medium | server/src/app/utils/waitingCharge.utils.ts:82
  // Partial wallet and no customerId (or no default card): the wallet is debited for its portion, the
  // card portion is silently skipped, yet the function returns method 'wallet+card' and the full amount,
  // so the caller believes the whole waiting charge was collected. Fix: return only the amount collected.
  it.fails('BUG FARE-01: reports only the collected amount when the card portion cannot be charged', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 4 }) as any);

    const result = await deductWaitingCharge('665f00000000000000000001', 10, 'ride-1');
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith('665f00000000000000000001', { $inc: { wallet: -4 } });
    // Correct behaviour: only the 4.00 actually collected is reported.
    expect(result.amount).toBe(4);
  });
});
