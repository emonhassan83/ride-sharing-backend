import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANDATORY_INITIAL_ESTIMATE_PERCENT,
  buildPassengerFareTotals,
  resolveInitialEstimatePercent,
  resolveSplitMatchedSurchargePercent,
  roundUpToFiveBracket,
} from './fareMath.utils';
import { DEFAULT_GENERAL_SETTINGS } from '../modules/settings/settings.constant';

// Approved worked example: day tariff, 50 km → 3.80 + 50 × 0.95 = €51.30
const REGULATED_BASE_50KM_DAY = 51.3;

const fare = (overrides: Partial<Parameters<typeof buildPassengerFareTotals>[0]> = {}) =>
  buildPassengerFareTotals({
    rideType: 'split',
    riderCount: 1,
    rawComponentFare: REGULATED_BASE_50KM_DAY,
    baseFare: 20,
    platformVatPercent: 9,
    platformCommissionPercent: 10,
    splitRideMatchedSurchargePercent: 0,
    fareRoundingBracket: 5,
    ...overrides,
  });

describe('+10% initial estimate (mandatory)', () => {
  it('is applied before €5 rounding: 51.30 × 1.10 = 56.43 → €60 (without it would be €55)', () => {
    const result = fare();
    assert.equal(result.fareBeforeFees, 56.43);
    assert.equal(result.totalFare, 60);
    assert.notEqual(result.totalFare, roundUpToFiveBracket(REGULATED_BASE_50KM_DAY));
  });

  it('cannot be omitted when the setting is 0, missing or invalid', () => {
    for (const value of [0, undefined, null, NaN, -5] as any[]) {
      const result = fare({ platformCommissionPercent: value });
      assert.equal(result.fareBeforeFees, 56.43, `value=${value}`);
      assert.equal(result.totalFare, 60, `value=${value}`);
    }
    assert.equal(resolveInitialEstimatePercent(0), MANDATORY_INITIAL_ESTIMATE_PERCENT);
    assert.equal(resolveInitialEstimatePercent(10), 10);
  });

  it('applies to private rides the same way', () => {
    assert.equal(fare({ rideType: 'private' }).totalFare, 60);
  });

  it('pushes a fare over a €5 boundary when it matters: 46 → 50.60 → €55', () => {
    const result = fare({ rawComponentFare: 46 });
    assert.equal(result.fareBeforeFees, 50.6);
    assert.equal(result.totalFare, 55);
  });
});

describe('PMC production defaults 10% / 30% / 50%', () => {
  it('PMCrfPR default is 10%', () => {
    assert.equal(MANDATORY_INITIAL_ESTIMATE_PERCENT, 10);
  });

  it('PMCrfSR tiers: 1 rider 0%, 2 riders 30%, 3+ riders 50%', () => {
    assert.equal(resolveSplitMatchedSurchargePercent(1), 0);
    assert.equal(resolveSplitMatchedSurchargePercent(2), 30);
    assert.equal(resolveSplitMatchedSurchargePercent(3), 50);
  });

  it('settings defaults match production values', () => {
    assert.equal(DEFAULT_GENERAL_SETTINGS.platformCommissionPercent, 10);
    assert.equal(DEFAULT_GENERAL_SETTINGS.splitRideMatchedSurchargePercent, 30);
    assert.equal(DEFAULT_GENERAL_SETTINGS.splitRideMatchedSurchargePercent3, 50);
  });
});

describe('Split ride worked example (approved formula)', () => {
  it('unmatched rider pays the initial upfront: €60', () => {
    assert.equal(fare({ riderCount: 1 }).totalFare, 60);
  });

  it('2 riders: pool 120 → avg 60 → +30% = 78 → ÷2 = 39 → €40', () => {
    const result = fare({
      riderCount: 2,
      splitRideMatchedSurchargePercent: 30,
      poolKomistraBase: 120,
    });
    assert.equal(result.fareBeforeFees, 60);
    assert.equal(result.splitRideMatchedSurchargeAmount, 18);
    assert.equal(result.totalFare, 40);
  });

  it('3 riders: pool 180 → avg 60 → +50% = 90 → ÷3 = 30 → €30', () => {
    const result = fare({
      riderCount: 3,
      splitRideMatchedSurchargePercent: 50,
      poolKomistraBase: 180,
    });
    assert.equal(result.fareBeforeFees, 60);
    assert.equal(result.splitRideMatchedSurchargeAmount, 30);
    assert.equal(result.totalFare, 30);
  });

  it('matched pool without explicit base is built from +10% initial upfronts', () => {
    const two = fare({ riderCount: 2, splitRideMatchedSurchargePercent: 30 });
    assert.equal(two.fareBeforeFees, 60);
    assert.equal(two.totalFare, 40);
  });

  it('minimum fare €20 still applies after matching', () => {
    const result = fare({
      rawComponentFare: 10,
      riderCount: 3,
      splitRideMatchedSurchargePercent: 50,
    });
    assert.equal(result.totalFare, 20);
  });
});
