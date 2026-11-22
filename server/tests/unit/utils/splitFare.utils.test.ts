/**
 * Unit tests: splitFare.utils (split-ride pricing, wallet/card charging, refunds, fare
 * recalculation under a Redis lock, cancellation refund windows, ownership transfer, fare lock).
 *
 * Fare inputs run through the REAL fareCalculator + fareMath (default settings: day 3.80 + 0.95/km,
 * night 4.80 + 1.10/km, min fare 20, 10% PMCrfPR, 9% VAT included, 5 EUR brackets, +30% / +50%
 * matched surcharge). Settings are served by the mocked Setting model (empty = defaults).
 *
 * Worked numbers (docs/FARE_CALCULATION_PRIVATE_SPLIT.md, day, 50 km):
 *   1 rider -> 60.00 (VAT 4.95), 2 riders -> 40.00 each, 3 riders -> 30.00 each.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRedis } from '@tests/helpers/fakeRedis';
import { mockDoc, mockQuery, mockQueryError, oid } from '@tests/helpers/mongoose';
import { Passenger } from '@src/app/modules/passenger/passenger.model';
import { Ride } from '@src/app/modules/ride/ride.model';
import { Booking } from '@src/app/modules/booking/booking.model';
import { Payment } from '@src/app/modules/payment/payment.model';
import { User } from '@src/app/modules/user/user.model';
import { Refund } from '@src/app/modules/refund/refund.model';
import { Setting } from '@src/app/modules/settings/settings.model';
import StripeService from '@src/app/config/stripe.config';
import { sendNotification } from '@src/app/utils/sentPushNotification';
import { modeType } from '@src/app/modules/notification/notification.interface';
import { PASSENGER_STATUS } from '@src/app/modules/passenger/passenger.constant';
import { PAYMENT_STATUS } from '@src/app/modules/payment/payment.constant';
import { REFUND_STATUS, REFUND_TYPE } from '@src/app/modules/refund/refund.constant';
import {
  DEFAULT_SPLIT_RIDE_MAX_MATCHED_RIDERS,
  acquireRecalculateLock,
  calcSplitPassengerFare,
  calculateCancellationRefund,
  chargeUser,
  computeSplitPoolKomistraBase,
  getSplitMaxMatchedRiders,
  lockSplitRideFare,
  recalculateSplitFares,
  refundToWallet,
  releaseRecalculateLock,
  transferRideOwnership,
} from '@src/app/utils/splitFare.utils';

vi.mock('@src/app/modules/passenger/passenger.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Passenger: createModelMock() };
});
vi.mock('@src/app/modules/ride/ride.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Ride: createModelMock() };
});
vi.mock('@src/app/modules/booking/booking.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Booking: createModelMock() };
});
vi.mock('@src/app/modules/payment/payment.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Payment: createModelMock() };
});
vi.mock('@src/app/modules/user/user.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { User: createModelMock() };
});
vi.mock('@src/app/modules/refund/refund.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Refund: createModelMock() };
});
vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
});
vi.mock('@src/app/config/stripe.config', () => ({ default: { getStripe: vi.fn() } }));
vi.mock('@src/app/utils/sentPushNotification', () => ({ sendNotification: vi.fn() }));

const DAY_DATE = new Date('2026-06-01T07:00:00Z');
const RIDE_ID = 'ride-1';
const LOCK_KEY = `ride:recalculate:lock:${RIDE_ID}`;

/** Replace the Setting collection (Setting.find for loadFareSettings, findOne for single keys). */
const setSettingDocs = (docs: Array<{ key: string; value: unknown }>) => {
  vi.mocked(Setting.find).mockReturnValue(mockQuery(docs) as any);
  vi.mocked(Setting.findOne).mockImplementation(((filter: { key: string }) =>
    mockQuery(docs.find((d) => d.key === filter.key) ?? null)) as any);
};

const makeStripe = () => ({
  customers: { retrieve: vi.fn() },
  paymentIntents: { create: vi.fn() },
});

describe('DEFAULT_SPLIT_RIDE_MAX_MATCHED_RIDERS', () => {
  it('is 3 matched riders', () => {
    expect(DEFAULT_SPLIT_RIDE_MAX_MATCHED_RIDERS).toBe(3);
  });
});

describe('getSplitMaxMatchedRiders', () => {
  beforeEach(() => {
    setSettingDocs([]);
  });

  it('returns the default of 3 when no setting exists', async () => {
    expect(await getSplitMaxMatchedRiders()).toBe(3);
  });

  it('reads the configured value from splitRideMaxMatchedRiders', async () => {
    setSettingDocs([{ key: 'splitRideMaxMatchedRiders', value: '2' }]);

    expect(await getSplitMaxMatchedRiders()).toBe(2);
  });

  it('treats 0 and negative values as unset (falls back to 3)', async () => {
    setSettingDocs([{ key: 'splitRideMaxMatchedRiders', value: 0 }]);
    expect(await getSplitMaxMatchedRiders()).toBe(3);

    setSettingDocs([{ key: 'splitRideMaxMatchedRiders', value: -2 }]);
    expect(await getSplitMaxMatchedRiders()).toBe(3);
  });

  it('treats a non-numeric value as unset (NaN falls back to 3)', async () => {
    setSettingDocs([{ key: 'splitRideMaxMatchedRiders', value: 'many' }]);

    expect(await getSplitMaxMatchedRiders()).toBe(3);
  });
});

describe('calcSplitPassengerFare (one rider\'s split quote)', () => {
  beforeEach(() => {
    setSettingDocs([]);
  });

  it('solo day ride of 50 km quotes 60.00 with 4.95 VAT and no surcharge (doc example)', async () => {
    const q = await calcSplitPassengerFare(50, 1, 1, 0, '10:00', DAY_DATE);

    expect(q.estimatedFare).toBe(60);
    expect(q.vatAmount).toBe(4.95);
    expect(q.surchargePercent).toBe(0);
    expect(q.surchargeAmount).toBe(0);
    expect(q.splitRideMatchedSurchargeAmount).toBe(0);
    expect(q.activeSplitPassengerCount).toBe(1);
    expect(q.minimumFareApplied).toBe(false);
    expect(q.minimumFareAdjustment).toBe(0);
  });

  it('exposes the km charge breakdown: 3.80 start + 50 x 0.95 = 47.50 km, 51.30 before PMCrfPR', async () => {
    const q = await calcSplitPassengerFare(50, 1, 1, 0, '10:00', DAY_DATE);

    expect(q.initialCharge).toBe(3.8);
    expect(q.totalKmCharge).toBe(47.5);
    expect(q.fareBeforePlatformCommission).toBe(51.3);
    expect(q.luggageCharge).toBe(0);
    expect(q.holidayTripCharge).toBe(0);
    expect(q.sixPassengerExtraCharge).toBe(0);
  });

  it('2 matched riders: each pays 40.00 (+30% shared surcharge, split by 2)', async () => {
    const q = await calcSplitPassengerFare(50, 1, 2, 0, '10:00', DAY_DATE);

    expect(q.estimatedFare).toBe(40);
    expect(q.surchargePercent).toBe(30);
    expect(q.surchargeAmount).toBe(9);
    expect(q.splitSurchargeAmount).toBe(9);
    expect(q.splitRideMatchedSurchargeAmount).toBe(9);
    expect(q.activeSplitPassengerCount).toBe(2);
  });

  it('3 matched riders: each pays 30.00 (+50% shared surcharge, split by 3)', async () => {
    const q = await calcSplitPassengerFare(50, 1, 3, 0, '10:00', DAY_DATE);

    expect(q.estimatedFare).toBe(30);
    expect(q.surchargePercent).toBe(50);
    expect(q.surchargeAmount).toBe(10);
  });

  it('a rider count of 0 or NaN is treated as a single rider', async () => {
    expect((await calcSplitPassengerFare(50, 1, 0, 0, '10:00', DAY_DATE)).estimatedFare).toBe(60);
    expect((await calcSplitPassengerFare(50, 1, NaN, 0, '10:00', DAY_DATE)).estimatedFare).toBe(60);
  });

  it('applies the 20.00 minimum fare to a very short trip and reports the adjustment (0 km)', async () => {
    // 3.80 * 1.10 = 4.18 -> 5 bracket, but minimum is 20
    const q = await calcSplitPassengerFare(0, 1, 1, 0, '10:00', DAY_DATE);

    expect(q.estimatedFare).toBe(20);
    expect(q.minimumFareApplied).toBe(true);
    expect(q.minimumFareAdjustment).toBe(15);
    expect(q.minimumFareAmount).toBe(20);
  });

  it('a negative distance is priced at the minimum fare (no negative quote)', async () => {
    const q = await calcSplitPassengerFare(-10, 1, 1, 0, '10:00', DAY_DATE);

    expect(q.estimatedFare).toBe(20);
  });

  it('night tariff applies between 20:30 and 05:59 (100 km: day 110 vs night 130)', async () => {
    expect((await calcSplitPassengerFare(100, 1, 1, 0, '20:29', DAY_DATE)).estimatedFare).toBe(110);
    expect((await calcSplitPassengerFare(100, 1, 1, 0, '20:30', DAY_DATE)).estimatedFare).toBe(130);
    expect((await calcSplitPassengerFare(100, 1, 1, 0, '05:59', DAY_DATE)).estimatedFare).toBe(130);
    expect((await calcSplitPassengerFare(100, 1, 1, 0, '06:00', DAY_DATE)).estimatedFare).toBe(110);
  });

  it('seats 4 has no six-seater uplift, seats 5 gets the +40% regulated-base uplift (boundary)', async () => {
    const four = await calcSplitPassengerFare(50, 4, 1, 0, '10:00', DAY_DATE);
    expect(four.sixPassengerExtraCharge).toBe(0);
    expect(four.estimatedFare).toBe(60);

    const five = await calcSplitPassengerFare(50, 5, 1, 0, '10:00', DAY_DATE);
    // 51.30 * 1.40 = 71.82 ; +10% = 79.00 ; bracket 80
    expect(five.sixPassengerExtraCharge).toBe(20.52);
    expect(five.estimatedFare).toBe(80);
  });

  it('luggage is never billed on split quotes', async () => {
    const q = await calcSplitPassengerFare(50, 1, 1, 9, '10:00', DAY_DATE);

    expect(q.luggageCharge).toBe(0);
    expect(q.estimatedFare).toBe(60);
  });

  it('uses a supplied pool komistra base for the matched-split average (150 pool -> 50 each)', async () => {
    const q = await calcSplitPassengerFare(50, 1, 2, 0, '10:00', DAY_DATE, { poolKomistraBase: 150 });

    // avg 75 * 1.30 = 97.50 ; per rider 48.75 ; bracket 50
    expect(q.estimatedFare).toBe(50);
  });

  it('reads the VAT rate from settings (12% -> 60 * 12 / 112 = 6.43)', async () => {
    setSettingDocs([{ key: 'platformVat', value: 12 }]);

    const q = await calcSplitPassengerFare(50, 1, 1, 0, '10:00', DAY_DATE);

    expect(q.platformVatPercent).toBe(12);
    expect(q.vatAmount).toBe(6.43);
  });

  it('reads the 3-rider surcharge from splitRideMatchedSurchargePercent3 (60% -> 35.00)', async () => {
    setSettingDocs([{ key: 'splitRideMatchedSurchargePercent3', value: 60 }]);

    const q = await calcSplitPassengerFare(50, 1, 3, 0, '10:00', DAY_DATE);

    // avg 60 * 1.60 = 96 ; per rider 32 ; bracket 35
    expect(q.surchargePercent).toBe(60);
    expect(q.estimatedFare).toBe(35);
  });

  it('CHARACTERIZATION: platform commission is not shown on split quotes (reported as 0)', async () => {
    const q = await calcSplitPassengerFare(50, 1, 2, 0, '10:00', DAY_DATE);

    expect(q.platformCommissionPercent).toBe(0);
    expect(q.platformCommissionAmount).toBe(0);
  });
});

describe('computeSplitPoolKomistraBase', () => {
  beforeEach(() => {
    setSettingDocs([]);
  });

  it('sums each order\'s solo initial upfront (two 50 km orders -> 120.00)', async () => {
    const total = await computeSplitPoolKomistraBase({
      departureTime: '10:00',
      departureDate: DAY_DATE,
      passengers: [
        { estimatedDistanceKm: 50, requestedSeats: 1 },
        { estimatedDistanceKm: 50, requestedSeats: 1 },
      ],
    });

    expect(total).toBe(120);
  });

  it('returns 0 for an empty passenger list', async () => {
    expect(
      await computeSplitPoolKomistraBase({ departureTime: '10:00', departureDate: DAY_DATE, passengers: [] }),
    ).toBe(0);
  });

  it('missing distance and seats are priced as 0 km and 1 seat (minimum 20 each)', async () => {
    const total = await computeSplitPoolKomistraBase({
      departureTime: '10:00',
      departureDate: DAY_DATE,
      passengers: [{}, {}],
    });

    expect(total).toBe(40);
  });
});

describe('acquireRecalculateLock / releaseRecalculateLock', () => {
  it('acquires once, refuses while held, and re-acquires after release', async () => {
    expect(await acquireRecalculateLock(RIDE_ID)).toBe(true);
    expect(await acquireRecalculateLock(RIDE_ID)).toBe(false);

    await releaseRecalculateLock(RIDE_ID);

    expect(await acquireRecalculateLock(RIDE_ID)).toBe(true);
  });

  it('stores the lock under ride:recalculate:lock:<rideId> with a 15 second TTL', async () => {
    await acquireRecalculateLock(RIDE_ID);

    expect(fakeRedis.peek(LOCK_KEY)).toBe('1');
    expect(await fakeRedis.ttl(LOCK_KEY)).toBe(15);
  });
});

describe('refundToWallet', () => {
  beforeEach(() => {
    vi.mocked(User.findById).mockReturnValue(mockQuery(null) as any);
    vi.mocked(sendNotification).mockResolvedValue(undefined as any);
  });

  it('does nothing for a zero or negative amount (boundary)', async () => {
    await refundToWallet('user-1', 0, 'r');
    await refundToWallet('user-1', -5, 'r');

    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('increments the wallet by the amount rounded to cents', async () => {
    await refundToWallet('user-1', 12.3456, 'fare_recalculate_passenger_joined');

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith('user-1', { $inc: { wallet: 12.35 } });
  });

  it('sends a push with a 2-decimal euro amount when the user has an FCM token', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ fcmToken: 'tok-1' }) as any);

    await refundToWallet('user-1', 20, 'r');

    expect(sendNotification).toHaveBeenCalledWith(['tok-1'], {
      receiver: 'user-1',
      message: 'Ride refund amount transfer',
      description: '€20.00 refunded to your wallet.',
      modelType: modeType.Refund,
    });
  });

  it('does not send a push when the user has no FCM token', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({}) as any);

    await refundToWallet('user-1', 20, 'r');

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('a failing push does not fail the refund', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ fcmToken: 'tok-1' }) as any);
    vi.mocked(sendNotification).mockRejectedValue(new Error('fcm down'));

    await expect(refundToWallet('user-1', 20, 'r')).resolves.toBeUndefined();
    expect(User.findByIdAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('a missing user still credits nothing extra and does not throw', async () => {
    await expect(refundToWallet('ghost', 5, 'r')).resolves.toBeUndefined();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('LIMITATION: a NaN amount passes the <= 0 guard and reaches the wallet increment as NaN', async () => {
    await refundToWallet('user-1', NaN, 'r');

    expect(User.findByIdAndUpdate).toHaveBeenCalledWith('user-1', { $inc: { wallet: NaN } });
  });
});

describe('chargeUser (wallet first, then saved card, Case 11 / 33)', () => {
  const stripe = makeStripe();

  beforeEach(() => {
    vi.mocked(StripeService.getStripe).mockReturnValue(stripe as any);
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 0 }) as any);
    stripe.customers.retrieve.mockResolvedValue({ invoice_settings: { default_payment_method: 'pm_1' } });
    stripe.paymentIntents.create.mockResolvedValue({ id: 'pi_1' });
  });

  it('succeeds without touching anything for a zero amount', async () => {
    expect(await chargeUser('user-1', 0, RIDE_ID, 'r')).toEqual({ success: true, method: 'none' });
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('fails with user_not_found when the user does not exist', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery(null) as any);

    expect(await chargeUser('ghost', 10, RIDE_ID, 'r')).toEqual({
      success: false,
      method: 'none',
      failReason: 'user_not_found',
    });
  });

  it('pays fully from the wallet when the balance equals the amount (boundary wallet == amount)', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 50 }) as any);
    const io = { to: vi.fn(() => ({ emit: vi.fn() })) };

    const result = await chargeUser('user-1', 50, RIDE_ID, 'fare_x', io);

    expect(result).toEqual({ success: true, method: 'wallet' });
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith('user-1', { $inc: { wallet: -50 } });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(fakeRedis.peek(`payment:charged:${RIDE_ID}:user-1:5000`)).toBe('wallet');
    expect(await fakeRedis.ttl(`payment:charged:${RIDE_ID}:user-1:5000`)).toBe(86400);
    expect(io.to).toHaveBeenCalledWith('user:user-1');
  });

  it('emits ride:payment-charged with the wallet method when paid in full from the wallet', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 100 }) as any);
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };

    await chargeUser('user-1', 50, RIDE_ID, 'fare_x', io);

    expect(emit).toHaveBeenCalledWith('ride:payment-charged', { amount: 50, method: 'wallet', reason: 'fare_x' });
  });

  it('is idempotent per ride, user and amount: a second call returns already_charged', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 100 }) as any);
    await chargeUser('user-1', 50, RIDE_ID, 'r');
    vi.mocked(User.findByIdAndUpdate).mockClear();

    expect(await chargeUser('user-1', 50, RIDE_ID, 'r')).toEqual({ success: true, method: 'already_charged' });
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('a different amount on the same ride is a new charge (idempotency key includes cents)', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 100 }) as any);
    await chargeUser('user-1', 50, RIDE_ID, 'r');

    expect(await chargeUser('user-1', 50.01, RIDE_ID, 'r')).toEqual({ success: true, method: 'wallet' });
  });

  it('splits the charge: wallet 30 + card 20.00 charged as 2000 cents, method wallet+card', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 30, customerId: 'cus_1' }) as any);

    const result = await chargeUser('user-1', 50, RIDE_ID, 'fare_x');

    expect(result).toEqual({ success: true, method: 'wallet+card' });
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith('user-1', { $inc: { wallet: -30 } });
    expect(stripe.customers.retrieve).toHaveBeenCalledWith('cus_1');
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith({
      amount: 2000,
      currency: 'eur',
      customer: 'cus_1',
      payment_method: 'pm_1',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { rideId: RIDE_ID, userId: 'user-1', reason: 'fare_x' },
    });
    expect(fakeRedis.peek(`payment:charged:${RIDE_ID}:user-1:5000`)).toBe('wallet+card');
  });

  it('with an empty wallet, charges the full amount on the card and does not touch the wallet', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 0, customerId: 'cus_1' }) as any);

    const result = await chargeUser('user-1', 50, RIDE_ID, 'r');

    expect(result).toEqual({ success: true, method: 'card' });
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 5000 }));
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('boundary: a 0.01 card remainder is charged as 1 cent', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 49.99, customerId: 'cus_1' }) as any);

    await chargeUser('user-1', 50, RIDE_ID, 'r');

    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 1 }));
  });

  it('when the card fails, restores the wallet portion and reports payment-failed to the rider', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 30, customerId: 'cus_1' }) as any);
    stripe.paymentIntents.create.mockRejectedValue(new Error('card_declined'));
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };

    const result = await chargeUser('user-1', 50, RIDE_ID, 'r', io);

    expect(result).toEqual({ success: false, method: 'failed', failReason: 'card_declined' });
    expect(User.findByIdAndUpdate).toHaveBeenNthCalledWith(1, 'user-1', { $inc: { wallet: -30 } });
    expect(User.findByIdAndUpdate).toHaveBeenNthCalledWith(2, 'user-1', { $inc: { wallet: 30 } });
    expect(emit).toHaveBeenCalledWith('ride:payment-failed', {
      amount: 50,
      reason: 'r',
      message: 'Payment failed. Please update your payment method.',
    });
    expect(fakeRedis.peek(`payment:charged:${RIDE_ID}:user-1:5000`)).toBeNull();
  });

  it('a customer without a default payment method fails with no_default_card and rolls back', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 30, customerId: 'cus_1' }) as any);
    stripe.customers.retrieve.mockResolvedValue({ invoice_settings: {} });

    const result = await chargeUser('user-1', 50, RIDE_ID, 'r');

    expect(result).toEqual({ success: false, method: 'failed', failReason: 'no_default_card' });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(User.findByIdAndUpdate).toHaveBeenLastCalledWith('user-1', { $inc: { wallet: 30 } });
  });

  it('a partial wallet with no saved card fails with no_payment_method and restores the wallet', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 30 }) as any);
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };

    const result = await chargeUser('user-1', 50, RIDE_ID, 'r', io);

    expect(result).toEqual({ success: false, method: 'failed', failReason: 'no_payment_method' });
    expect(User.findByIdAndUpdate).toHaveBeenLastCalledWith('user-1', { $inc: { wallet: 30 } });
    expect(emit).toHaveBeenCalledWith('ride:payment-failed', {
      amount: 50,
      reason: 'r',
      message: 'No payment method found.',
    });
  });

  it('an empty wallet with no saved card fails without any wallet write', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 0 }) as any);

    expect(await chargeUser('user-1', 50, RIDE_ID, 'r')).toEqual({
      success: false,
      method: 'failed',
      failReason: 'no_payment_method',
    });
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('a Stripe customer lookup error is treated as a failed card charge and rolls back', async () => {
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 30, customerId: 'cus_1' }) as any);
    stripe.customers.retrieve.mockRejectedValue(new Error('stripe unavailable'));

    expect(await chargeUser('user-1', 50, RIDE_ID, 'r')).toEqual({
      success: false,
      method: 'failed',
      failReason: 'stripe unavailable',
    });
    expect(User.findByIdAndUpdate).toHaveBeenLastCalledWith('user-1', { $inc: { wallet: 30 } });
  });

  it('it.fails BUG SPLIT-03: a card that was already charged is not rolled back when only the post-charge bookkeeping fails', async () => {
    // BUG-REPORT SPLIT-03 | MEDIUM | src/app/utils/splitFare.utils.ts:285-305
    // The PaymentIntent with confirm:true succeeds, then redis.set(idemKey) throws inside the same
    // try block. The catch restores the wallet and reports "payment failed" although the card was
    // charged, so the rider is charged with no ride payment recorded and a retry can charge again.
    // Fix: move the post-charge redis/io work outside the try (or treat it as best-effort).
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 30, customerId: 'cus_1' }) as any);
    vi.spyOn(fakeRedis, 'set').mockRejectedValueOnce(new Error('redis write failed'));

    await chargeUser('user-1', 50, RIDE_ID, 'r');

    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalledWith('user-1', { $inc: { wallet: 30 } });
  });
});

describe('calculateCancellationRefund (Cases 20-21)', () => {
  const inHours = (h: number) => new Date(Date.now() + h * 3600 * 1000);

  beforeEach(() => {
    // Defaults: split 24 h, private 1 h (rideSchedule.utils)
    setSettingDocs([]);
  });

  it('returns no_amount_paid for zero or negative amounts', async () => {
    const zero = { refundAmount: 0, platformAmount: 0, refundReason: 'no_amount_paid' };
    expect(await calculateCancellationRefund(0, inHours(48), 'split')).toEqual(zero);
    expect(await calculateCancellationRefund(-5, inHours(48), 'split')).toEqual(zero);
  });

  it('refunds in full outside the split 24 h window (24 h + 1 min away)', async () => {
    const dep = new Date(Date.now() + 24 * 3600 * 1000 + 60 * 1000);

    expect(await calculateCancellationRefund(60, dep, 'split')).toEqual({
      refundAmount: 60,
      platformAmount: 0,
      refundReason: 'outside_refund_restriction_window',
    });
  });

  it('restricts the refund at exactly 24 h before a split departure (inclusive boundary)', async () => {
    const dep = new Date(Date.now() + 24 * 3600 * 1000);

    expect(await calculateCancellationRefund(60, dep, 'split')).toEqual({
      refundAmount: 0,
      platformAmount: 60,
      refundReason: 'split_refund_restricted_24h_before_pickup',
    });
  });

  it('private rides use the 1 h window: 61 min away refunds, 60 min away is restricted', async () => {
    const outside = new Date(Date.now() + 61 * 60 * 1000);
    const inside = new Date(Date.now() + 60 * 60 * 1000);

    expect((await calculateCancellationRefund(30, outside, 'private')).refundAmount).toBe(30);
    expect(await calculateCancellationRefund(30, inside, 'private')).toEqual({
      refundAmount: 0,
      platformAmount: 30,
      refundReason: 'private_refund_restricted_1h_before_pickup',
    });
  });

  it('a departure already in the past is kept by the platform', async () => {
    expect(await calculateCancellationRefund(30, inHours(-1), 'private')).toEqual({
      refundAmount: 0,
      platformAmount: 30,
      refundReason: 'cancelled_after_departure',
    });
  });

  it('a departure exactly now is treated as restricted, not as after departure (0 h)', async () => {
    const now = new Date();
    vi.setSystemTime(now);

    expect((await calculateCancellationRefund(30, now, 'private')).refundReason).toBe(
      'private_refund_restricted_1h_before_pickup',
    );
  });

  it('uses a configured split restriction (6 h): 6 h away is restricted, 6 h + 1 min is refunded', async () => {
    setSettingDocs([{ key: 'splitRideRefundRestrictionHours', value: 6 }]);

    expect((await calculateCancellationRefund(40, inHours(6), 'split')).refundReason).toBe(
      'split_refund_restricted_6h_before_pickup',
    );
    expect(
      (await calculateCancellationRefund(40, new Date(Date.now() + 6 * 3600000 + 60000), 'split')).refundAmount,
    ).toBe(40);
  });

  it('CHARACTERIZATION: a stored restriction of 0 hours falls back to the 24 h default', async () => {
    setSettingDocs([{ key: 'splitRideRefundRestrictionHours', value: 0 }]);

    expect((await calculateCancellationRefund(40, inHours(12), 'split')).refundAmount).toBe(0);
  });

  it('CHARACTERIZATION: an invalid departure Date (NaN hours) is refunded in full', async () => {
    const result = await calculateCancellationRefund(40, new Date('not-a-date'), 'split');

    expect(result).toEqual({ refundAmount: 40, platformAmount: 0, refundReason: 'outside_refund_restriction_window' });
  });
});

describe('recalculateSplitFares (fare recalculation under lock)', () => {
  const ride = (over: Record<string, unknown> = {}) => ({
    _id: RIDE_ID,
    type: 'split',
    departureDate: '2026-06-01',
    departureTime: '10:00',
    splitFareLocked: false,
    notifiedDriverIds: [] as unknown[],
    driverId: undefined as unknown,
    ...over,
  });

  const passenger = (over: Record<string, unknown> = {}) => ({
    _id: oid(),
    userId: oid(),
    rideId: RIDE_ID,
    estimatedDistanceKm: 50,
    requestedSeats: 1,
    estimatedFare: 60,
    status: PASSENGER_STATUS.confirmed,
    ...over,
  });

  /**
   * Wire the models for one recalculation run.
   * `target` is the passenger whose booking/payment the test inspects; other passengers have none.
   */
  const wire = (opts: {
    passengers: any[];
    rideDoc?: any;
    target?: any;
    booking?: any;
    payment?: any;
  }) => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(opts.rideDoc ?? ride()) as any);
    vi.mocked(Passenger.find).mockReturnValue(mockQuery(opts.passengers) as any);
    vi.mocked(Booking.findOne).mockImplementation(((f: any) =>
      mockQuery(opts.booking && f.passengerId === opts.target?._id ? opts.booking : null)) as any);
    vi.mocked(Payment.findOne).mockImplementation(((f: any) =>
      mockQuery(opts.payment && opts.booking && f.booking === opts.booking._id ? opts.payment : null)) as any);
    vi.mocked(User.findById).mockReturnValue(mockQuery({}) as any);
    setSettingDocs([]);
  };

  const bookingDoc = () =>
    mockDoc({ _id: oid(), totalFare: 60, amountPaid: 0, refundAmount: 0, paymentStatus: PAYMENT_STATUS.unpaid });

  const paymentDoc = (status: string, over: Record<string, unknown> = {}) =>
    mockDoc({
      _id: oid(),
      status,
      amount: 60,
      authorizedAmount: 60,
      amountToCapture: 60,
      platformCommission: 6,
      providerEarning: 54,
      ...over,
    });

  beforeEach(() => {
    vi.mocked(Passenger.findByIdAndUpdate).mockReturnValue(mockQuery(null) as any);
    vi.mocked(Ride.findByIdAndUpdate).mockReturnValue(mockQuery(null) as any);
    vi.mocked(Refund.create).mockResolvedValue({} as any);
  });

  it('acquires the lock and always releases it afterwards', async () => {
    wire({ passengers: [] });

    await recalculateSplitFares(RIDE_ID, 'passenger_joined');

    expect(fakeRedis.peek(LOCK_KEY)).toBeNull();
  });

  it('loads only active passengers (pending, confirmed, in_progress, driver_arrived)', async () => {
    wire({ passengers: [] });

    await recalculateSplitFares(RIDE_ID, 'passenger_joined');

    expect(Passenger.find).toHaveBeenCalledWith({
      rideId: RIDE_ID,
      status: {
        $in: [
          PASSENGER_STATUS.pending,
          PASSENGER_STATUS.confirmed,
          PASSENGER_STATUS.in_progress,
          PASSENGER_STATUS.driver_arrived,
        ],
      },
    });
  });

  it('returns without changes when there are no active passengers (lock still released)', async () => {
    wire({ passengers: [] });

    await recalculateSplitFares(RIDE_ID, 'passenger_cancelled');

    expect(Ride.findById).not.toHaveBeenCalled();
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('returns without changes when the ride does not exist', async () => {
    wire({ passengers: [passenger()], rideDoc: null });
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(null) as any);

    await recalculateSplitFares(RIDE_ID, 'passenger_joined');

    expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(fakeRedis.peek(LOCK_KEY)).toBeNull();
  });

  it('does nothing when the split fare is already locked', async () => {
    const p = passenger({ estimatedFare: 60 });
    wire({ passengers: [p, passenger()], rideDoc: ride({ splitFareLocked: true }) });

    await recalculateSplitFares(RIDE_ID, 'passenger_joined');

    expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('skips passengers whose fare did not change (1 rider already at 60.00)', async () => {
    wire({ passengers: [passenger({ estimatedFare: 60 })] });

    await recalculateSplitFares(RIDE_ID, 'passenger_joined');

    expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ estimatedFare: expect.anything() }));
    // Ride summary is still refreshed
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(RIDE_ID, { currentSurchargePercent: 0, bookedSeats: 1 });
  });

  it('a second rider re-prices both riders from 60.00 to 40.00 and updates the ride surcharge (30%)', async () => {
    const target = passenger({ estimatedFare: 60 });
    const other = passenger({ estimatedFare: 60 });
    wire({ passengers: [target, other] });

    await recalculateSplitFares(RIDE_ID, 'passenger_joined');

    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(
      target._id,
      expect.objectContaining({
        estimatedFare: 40,
        totalFare: 40,
        surchargePercent: 30,
        surchargeAmount: 9,
        totalKmCharge: 47.5,
        luggageCharge: 0,
        holidayTripCharge: 0,
      }),
    );
    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(other._id, expect.objectContaining({ estimatedFare: 40 }));
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(RIDE_ID, { currentSurchargePercent: 30, bookedSeats: 2 });
  });

  it('bookedSeats on the ride is the exact sum of requested seats (2 + 1 = 3)', async () => {
    wire({ passengers: [passenger({ requestedSeats: 2 }), passenger({ requestedSeats: undefined })] });

    await recalculateSplitFares(RIDE_ID, 'passenger_joined');

    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(RIDE_ID, expect.objectContaining({ bookedSeats: 3 }));
  });

  it('unpaid payment: the amount and booking total follow the new fare without any charge or refund', async () => {
    const target = passenger({ estimatedFare: 60 });
    const booking = bookingDoc();
    const payment = paymentDoc(PAYMENT_STATUS.unpaid);
    wire({ passengers: [target, passenger()], target, booking, payment });

    await recalculateSplitFares(RIDE_ID, 'passenger_joined');

    expect(payment.amount).toBe(40);
    expect(payment.save).toHaveBeenCalled();
    expect(booking.totalFare).toBe(40);
    expect(booking.save).toHaveBeenCalled();
    expect(Refund.create).not.toHaveBeenCalled();
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('authorized payment, new fare below the authorized amount: stays authorized, capture reduced to 40.00', async () => {
    const target = passenger({ estimatedFare: 60 });
    const booking = bookingDoc();
    const payment = paymentDoc(PAYMENT_STATUS.authorized);
    wire({ passengers: [target, passenger()], target, booking, payment });

    await recalculateSplitFares(RIDE_ID, 'passenger_joined');

    expect(payment.status).toBe(PAYMENT_STATUS.authorized);
    expect(payment.amountToCapture).toBe(40);
    expect(payment.amount).toBe(40);
    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(target._id, { paymentStatus: PAYMENT_STATUS.authorized });
    expect(booking.paymentStatus).toBe(PAYMENT_STATUS.authorized);
    expect(booking.amountPaid).toBe(0);
  });

  it('authorized payment, new fare above the authorized amount: requires re-authorization and clears driver request cards', async () => {
    // Solo rider authorized at 40.00 whose fare is now 60.00 (+20.00 > 0.01 tolerance)
    const target = passenger({ estimatedFare: 40 });
    const booking = bookingDoc();
    const driverA = oid();
    const driverB = oid();
    const payment = paymentDoc(PAYMENT_STATUS.authorized, { authorizedAmount: 40, amount: 40 });
    wire({
      passengers: [target],
      rideDoc: ride({ notifiedDriverIds: [driverA, driverB], driverId: driverA }),
      target,
      booking,
      payment,
    });
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };

    await recalculateSplitFares(RIDE_ID, 'passenger_joined', io);

    expect(payment.status).toBe(PAYMENT_STATUS.requires_reauthorization);
    expect(payment.amountToCapture).toBe(40);
    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(target._id, {
      paymentStatus: PAYMENT_STATUS.requires_reauthorization,
    });
    expect(booking.paymentStatus).toBe(PAYMENT_STATUS.requires_reauthorization);
    expect(io.to).toHaveBeenCalledWith(`driver:${driverA}`);
    expect(io.to).toHaveBeenCalledWith(`driver:${driverB}`);
    expect(io.to).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('ride:request-removed', {
      rideId: RIDE_ID,
      passengerId: target._id,
      reason: 'payment_requires_reauthorization',
      message: 'Passenger must re-authorize the updated fare. Request removed for now.',
    });
  });

  it('a driver listed both as notified and as assigned is notified once', async () => {
    const target = passenger({ estimatedFare: 40 });
    const driver = oid();
    const payment = paymentDoc(PAYMENT_STATUS.authorized, { authorizedAmount: 40, amount: 40 });
    wire({
      passengers: [target],
      rideDoc: ride({ notifiedDriverIds: [driver], driverId: driver }),
      target,
      booking: bookingDoc(),
      payment,
    });
    const io = { to: vi.fn(() => ({ emit: vi.fn() })) };

    await recalculateSplitFares(RIDE_ID, 'passenger_joined', io);

    expect(io.to).toHaveBeenCalledTimes(1);
  });

  it('re-authorization without a socket server still updates the payment and does not throw', async () => {
    const target = passenger({ estimatedFare: 40 });
    const payment = paymentDoc(PAYMENT_STATUS.authorized, { authorizedAmount: 40, amount: 40 });
    wire({ passengers: [target], target, booking: bookingDoc(), payment });

    await expect(recalculateSplitFares(RIDE_ID, 'passenger_joined')).resolves.toBeUndefined();
    expect(payment.status).toBe(PAYMENT_STATUS.requires_reauthorization);
  });

  it('boundary: an authorized fare that rises by exactly 0.00 keeps the authorized status', async () => {
    const target = passenger({ estimatedFare: 60 });
    const payment = paymentDoc(PAYMENT_STATUS.authorized, { authorizedAmount: 60 });
    wire({ passengers: [target], target, booking: bookingDoc(), payment });

    await recalculateSplitFares(RIDE_ID, 'passenger_joined');

    expect(payment.status).toBe(PAYMENT_STATUS.authorized);
  });

  it('it.fails BUG SPLIT-01: a split recalculation keeps the platform commission on the payment', async () => {
    // BUG-REPORT SPLIT-01 | HIGH | src/app/utils/splitFare.utils.ts:420-425, 438-440, 490-492, 503-505
    // calcSplitPassengerFare returns platformCommissionAmount 0 (fareMath), so the recalc writes
    // payment.platformCommission = 0 and providerEarning = the full fare. The capture path
    // (payment.service getCommissionBreakdown) computes the real fee + VAT. Fix: derive the commission
    // from computeDriverPayoutFromPassengerTotal (as payment.service does) instead of the fare result.
    const target = passenger({ estimatedFare: 60 });
    const payment = paymentDoc(PAYMENT_STATUS.authorized, { platformCommission: 0, providerEarning: 0 });
    wire({ passengers: [target, passenger()], target, booking: bookingDoc(), payment });

    await recalculateSplitFares(RIDE_ID, 'passenger_joined');

    expect(payment.platformCommission).toBeGreaterThan(0);
    expect(payment.providerEarning).toBeLessThan(40);
  });

  it('paid payment, fare dropped: amount updated, booking refund recorded and the difference refunded to the wallet', async () => {
    const target = passenger({ estimatedFare: 60 });
    const booking = bookingDoc();
    booking.paymentStatus = PAYMENT_STATUS.paid as any;
    booking.refundAmount = 5;
    const payment = paymentDoc(PAYMENT_STATUS.paid);
    wire({ passengers: [target, passenger()], target, booking, payment });
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };

    await recalculateSplitFares(RIDE_ID, 'passenger_joined', io);

    expect(payment.amount).toBe(40);
    expect(booking.totalFare).toBe(40);
    expect(booking.amountPaid).toBe(40);
    expect(booking.refundAmount).toBe(25);
    expect(Refund.create).toHaveBeenCalledWith({
      user: target.userId,
      ride: RIDE_ID,
      amount: 20,
      type: REFUND_TYPE.split_ride,
      reason: 'fare_recalculate_passenger_joined',
      note: 'Fare automatically adjusted for split ride. Reason: passenger_joined.',
      status: REFUND_STATUS.confirmed,
    });
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(target.userId.toString(), { $inc: { wallet: 20 } });
    expect(emit).toHaveBeenCalledWith(
      'ride:fare-adjusted',
      expect.objectContaining({ oldFare: 60, newFare: 40, diff: -20, message: 'You saved €20.00!' }),
    );
  });

  it('paid payment, fare rose and the wallet + card cover it: no pending recovery and rider told the increase', async () => {
    // One rider at 40.00 (paid) whose fare becomes 60.00: diff +20.00
    const target = passenger({ estimatedFare: 40 });
    const payment = paymentDoc(PAYMENT_STATUS.paid);
    wire({ passengers: [target], target, booking: bookingDoc(), payment });
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 100 }) as any);
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };

    await recalculateSplitFares(RIDE_ID, 'passenger_cancelled', io);

    expect(Passenger.findByIdAndUpdate).not.toHaveBeenCalledWith(target._id, { paymentStatus: 'pending_recovery' });
    expect(emit).toHaveBeenCalledWith(
      'ride:fare-adjusted',
      expect.objectContaining({ diff: 20, message: 'Your fare increased by €20.00.' }),
    );
    expect(Refund.create).not.toHaveBeenCalled();
  });

  it('paid payment, fare rose and cannot be recovered: passenger is marked pending_recovery', async () => {
    const target = passenger({ estimatedFare: 40 });
    const payment = paymentDoc(PAYMENT_STATUS.paid);
    wire({ passengers: [target], target, booking: bookingDoc(), payment });
    vi.mocked(User.findById).mockReturnValue(mockQuery({ wallet: 0 }) as any);

    await recalculateSplitFares(RIDE_ID, 'passenger_cancelled');

    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(target._id, { paymentStatus: 'pending_recovery' });
  });

  it('a fare change on a payment that is neither unpaid, authorized nor paid only updates the passenger', async () => {
    const target = passenger({ estimatedFare: 60 });
    const payment = paymentDoc(PAYMENT_STATUS.failed ?? 'failed');
    wire({ passengers: [target, passenger()], target, booking: bookingDoc(), payment });

    await recalculateSplitFares(RIDE_ID, 'passenger_joined');

    expect(payment.save).not.toHaveBeenCalled();
    expect(Passenger.findByIdAndUpdate).toHaveBeenCalledWith(target._id, expect.objectContaining({ estimatedFare: 40 }));
  });

  it('releases the lock even when a database call throws', async () => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(ride()) as any);
    vi.mocked(Passenger.find).mockReturnValue(mockQueryError(new Error('db down')) as any);

    await expect(recalculateSplitFares(RIDE_ID, 'passenger_joined')).rejects.toThrow('db down');
    expect(fakeRedis.peek(LOCK_KEY)).toBeNull();
  });

  it('when the lock is held for all three attempts it gives up quietly without touching fares', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await fakeRedis.set(LOCK_KEY, '1');
    wire({ passengers: [passenger()] });

    const run = recalculateSplitFares(RIDE_ID, 'passenger_joined');
    await vi.advanceTimersByTimeAsync(1800);
    await expect(run).resolves.toBeUndefined();

    expect(Passenger.find).not.toHaveBeenCalled();
    expect(fakeRedis.peek(LOCK_KEY)).toBe('1');
    vi.useRealTimers();
  });

  it('retries the lock after 600 ms and proceeds when it becomes free (second attempt)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await fakeRedis.set(LOCK_KEY, '1');
    setTimeout(() => void fakeRedis.del(LOCK_KEY), 300);
    wire({ passengers: [] });

    const run = recalculateSplitFares(RIDE_ID, 'passenger_joined');
    await vi.advanceTimersByTimeAsync(700);
    await run;

    expect(Passenger.find).toHaveBeenCalledTimes(1);
    expect(fakeRedis.peek(LOCK_KEY)).toBeNull();
    vi.useRealTimers();
  });
});

describe('transferRideOwnership (creator cancelled, Case 6 follow-up)', () => {
  const remaining = (over: Record<string, unknown> = {}) => ({
    _id: oid(),
    userId: oid(),
    pickup: { type: 'Point', coordinates: [33.38, 35.18] },
    destination: { type: 'Point', coordinates: [33.1, 35.0] },
    ...over,
  });

  beforeEach(() => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery({ driverId: undefined }) as any);
    vi.mocked(Ride.findByIdAndUpdate).mockReturnValue(mockQuery(null) as any);
  });

  it('returns false and changes nothing when no other active passenger remains', async () => {
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([]) as any);

    expect(await transferRideOwnership(RIDE_ID, 'user-1')).toBe(false);
    expect(Ride.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('queries other, non-cancelled and non-rejected passengers oldest first', async () => {
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([]) as any);

    await transferRideOwnership(RIDE_ID, 'user-1');

    expect(Passenger.find).toHaveBeenCalledWith({
      rideId: RIDE_ID,
      userId: { $ne: 'user-1' },
      status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
    });
  });

  it('hands the ride to the oldest remaining passenger and copies their pickup and destination', async () => {
    const first = remaining();
    const second = remaining();
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([first, second]) as any);

    expect(await transferRideOwnership(RIDE_ID, 'user-1')).toBe(true);
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(RIDE_ID, {
      rideCreatedBy: first.userId,
      pickup: first.pickup,
      destination: first.destination,
    });
  });

  it('a single remaining passenger becomes the owner (boundary of 1)', async () => {
    const only = remaining();
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([only]) as any);

    expect(await transferRideOwnership(RIDE_ID, 'user-1')).toBe(true);
    expect(Ride.findByIdAndUpdate).toHaveBeenCalledWith(RIDE_ID, expect.objectContaining({ rideCreatedBy: only.userId }));
  });

  it('notifies the assigned driver of the new pickup when a driver is assigned', async () => {
    const first = remaining();
    const driverId = oid();
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([first]) as any);
    vi.mocked(Ride.findById).mockReturnValue(mockQuery({ driverId }) as any);
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };

    await transferRideOwnership(RIDE_ID, 'user-1', io);

    expect(io.to).toHaveBeenCalledWith(`driver:${driverId}`);
    expect(emit).toHaveBeenCalledWith('ride:pickup-updated', {
      rideId: RIDE_ID,
      newPickup: first.pickup,
      newDestination: first.destination,
      message: 'Pickup updated - original creator cancelled.',
    });
  });

  it('does not emit when no driver is assigned yet', async () => {
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([remaining()]) as any);
    const io = { to: vi.fn(() => ({ emit: vi.fn() })) };

    await transferRideOwnership(RIDE_ID, 'user-1', io);

    expect(io.to).not.toHaveBeenCalled();
  });
});

describe('lockSplitRideFare', () => {
  const splitRide = (over: Record<string, unknown> = {}) =>
    mockDoc({
      _id: RIDE_ID,
      type: 'split',
      departureDate: '2026-06-01',
      departureTime: '10:00',
      splitFareLocked: false,
      notifiedDriverIds: [],
      ...over,
    });

  beforeEach(() => {
    vi.mocked(Passenger.find).mockReturnValue(mockQuery([]) as any);
    vi.mocked(Ride.findByIdAndUpdate).mockReturnValue(mockQuery(null) as any);
    vi.mocked(Ride.findOneAndUpdate).mockReturnValue(mockQuery(null) as any);
    setSettingDocs([]);
  });

  it('returns false for a missing ride', async () => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(null) as any);

    expect(await lockSplitRideFare(RIDE_ID, 'departure_time')).toBe(false);
  });

  it('returns false for a private ride (only split rides lock)', async () => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(splitRide({ type: 'private' })) as any);

    expect(await lockSplitRideFare(RIDE_ID, 'departure_time')).toBe(false);
    expect(Ride.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('returns true without recalculating when the fare is already locked', async () => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(splitRide({ splitFareLocked: true })) as any);

    expect(await lockSplitRideFare(RIDE_ID, 'trip_start')).toBe(true);
    expect(Passenger.find).not.toHaveBeenCalled();
  });

  it('locks the ride atomically (only if still unlocked) with the reason and timestamp', async () => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(splitRide()) as any);
    const lockedAt = new Date('2026-06-01T08:00:00Z');
    vi.mocked(Ride.findOneAndUpdate).mockReturnValue(
      mockQuery({ splitFareLockedAt: lockedAt }) as any,
    );
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };

    expect(await lockSplitRideFare(RIDE_ID, 'trip_start', io)).toBe(true);

    expect(Ride.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: RIDE_ID, splitFareLocked: { $ne: true } },
      expect.objectContaining({ splitFareLocked: true, splitFareLockReason: 'trip_start' }),
      { returnDocument: 'after' },
    );
    expect(io.to).toHaveBeenCalledWith(`ride:${RIDE_ID}`);
    expect(emit).toHaveBeenCalledWith('ride:split-fare-locked', {
      rideId: RIDE_ID,
      reason: 'trip_start',
      lockedAt,
      message: 'Split ride fare has been finalized.',
    });
  });

  it('returns false when another request won the lock race and the ride was not already locked on read', async () => {
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(splitRide()) as any);
    vi.mocked(Ride.findOneAndUpdate).mockReturnValue(mockQuery(null) as any);
    const io = { to: vi.fn(() => ({ emit: vi.fn() })) };

    expect(await lockSplitRideFare(RIDE_ID, 'departure_time', io)).toBe(false);
    expect(io.to).not.toHaveBeenCalled();
  });

  it('it.fails BUG SPLIT-02: the fare is not locked when the recalculation could not run', async () => {
    // BUG-REPORT SPLIT-02 | MEDIUM | src/app/utils/splitFare.utils.ts:684-694
    // recalculateSplitFares silently returns when it cannot get the recalc lock (3 tries), but
    // lockSplitRideFare then locks the ride anyway, so passengers are charged on stale estimates.
    // Fix: have recalculateSplitFares return a status and skip the lock (or retry) when it did not run.
    vi.mocked(Ride.findById).mockReturnValue(mockQuery(splitRide()) as any);
    await fakeRedis.set(LOCK_KEY, '1');
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    const run = lockSplitRideFare(RIDE_ID, 'departure_time');
    await vi.advanceTimersByTimeAsync(1800);
    const locked = await run;
    vi.useRealTimers();

    expect(locked).toBe(false);
    expect(Ride.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
