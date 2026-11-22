/**
 * Unit tests: fare & driver-payout math.
 *
 * Source of truth for expected numbers: docs/FARE_CALCULATION_PRIVATE_SPLIT.md
 * (day, 50 km → private €60; split 2 riders → €40 each; 3 riders → €30 each).
 *
 * `fareMath.utils` is the money core of the platform: every rider price, VAT line and
 * driver earning flows through it, so boundaries (€5 brackets, €20 minimum, 06:00 /
 * 20:30 day-night switch) are tested exhaustively.
 */
import { describe, expect, it } from 'vitest';
import {
  MANDATORY_INITIAL_ESTIMATE_PERCENT,
  applyMinimumFare,
  buildDriverPayout,
  buildPassengerFareTotals,
  computeDriverPayoutFromPassengerTotal,
  extractIncludedVat,
  getDayNightRates,
  isDayFareDateTime,
  isDayFareTime,
  resolveInitialEstimatePercent,
  resolveSplitMatchedSurchargePercent,
  reversePassengerTotalToBase,
  roundMoney,
  roundUpToFiveBracket,
} from '@src/app/utils/fareMath.utils';
import { useRideTimeZone } from '@tests/helpers/time';

// Default platform settings (see DEFAULTS in fareCalculator.ts)
const DAY_REGULATED_BASE_50KM = 3.8 + 50 * 0.95; // 51.30

const baseInput = {
  rideType: 'private' as const,
  riderCount: 1,
  rawComponentFare: DAY_REGULATED_BASE_50KM,
  baseFare: 20,
  platformVatPercent: 9,
  platformCommissionPercent: 10,
  splitRideMatchedSurchargePercent: 30,
};

describe('roundMoney', () => {
  it('rounds to 2 decimals', () => {
    expect(roundMoney(1.234)).toBe(1.23);
    expect(roundMoney(1.236)).toBe(1.24);
    expect(roundMoney(10)).toBe(10);
  });

  it('removes binary floating point noise (0.1 + 0.2)', () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(51.3 * 1.1)).toBe(56.43);
  });

  it('coerces null / undefined / NaN / empty string to 0', () => {
    expect(roundMoney(undefined as unknown as number)).toBe(0);
    expect(roundMoney(null as unknown as number)).toBe(0);
    expect(roundMoney(NaN)).toBe(0);
    expect(roundMoney('' as unknown as number)).toBe(0);
  });

  it('accepts numeric strings', () => {
    expect(roundMoney('12.5' as unknown as number)).toBe(12.5);
  });

  it('keeps negatives symmetric (refund / adjustment amounts)', () => {
    expect(roundMoney(-1.236)).toBe(-1.24);
  });

  it('LIMITATION: half-cent values follow binary float, not decimal half-up (1.005 -> 1.00)', () => {
    // Documented, not endorsed: Math.round(x*100)/100 cannot represent 1.005 exactly.
    expect(roundMoney(1.005)).toBe(1);
  });
});

describe('resolveInitialEstimatePercent (mandatory +10% PMCrfPR)', () => {
  it('exposes the client-mandated 10%', () => {
    expect(MANDATORY_INITIAL_ESTIMATE_PERCENT).toBe(10);
  });

  it('uses a positive configured value', () => {
    expect(resolveInitialEstimatePercent(12)).toBe(12);
    expect(resolveInitialEstimatePercent(0.5)).toBe(0.5);
    expect(resolveInitialEstimatePercent('15' as unknown as number)).toBe(15);
  });

  it.each([0, -5, NaN, Infinity, undefined, null])(
    'falls back to the mandatory 10%% for %s (commission can never drop out)',
    (value) => {
      expect(resolveInitialEstimatePercent(value as number)).toBe(10);
    },
  );
});

describe('roundUpToFiveBracket', () => {
  it.each([
    [56.43, 60], // spec example: 51.30 * 1.10 -> €60
    [60, 60], // exact multiple stays
    [60.01, 65], // one cent over -> next bracket
    [65, 65],
    [0.01, 5],
    [4.99, 5],
    [5, 5],
    [5.01, 10],
    [119.99, 120],
  ])('ceil(%f) to €5 bracket = %f', (amount, expected) => {
    expect(roundUpToFiveBracket(amount)).toBe(expected);
  });

  it('works in integer cents so float drift cannot push an exact multiple up', () => {
    expect(roundUpToFiveBracket(59.99999999999999)).toBe(60);
    expect(roundUpToFiveBracket(0.1 + 0.2)).toBe(5);
    expect(roundUpToFiveBracket(20.000000000000004)).toBe(20);
  });

  it.each([0, -1, -100, NaN, undefined, null])(
    'returns 0 for non-positive / invalid amount %s',
    (amount) => {
      expect(roundUpToFiveBracket(amount as number)).toBe(0);
    },
  );

  it('supports a configurable bracket', () => {
    expect(roundUpToFiveBracket(60.01, 10)).toBe(70);
    expect(roundUpToFiveBracket(60, 10)).toBe(60);
    expect(roundUpToFiveBracket(1, 10)).toBe(10);
    expect(roundUpToFiveBracket(56.43, 2.5)).toBe(57.5);
    expect(roundUpToFiveBracket(0.4, 1)).toBe(1);
  });

  it.each([0, -5, NaN])(
    'does not bracket-round (just cents-rounds) when bracket is invalid: %s',
    (bracket) => {
      expect(roundUpToFiveBracket(56.437, bracket)).toBe(56.44);
    },
  );
});

describe('extractIncludedVat (VAT is already inside the gross price)', () => {
  it('extracts gross * v / (100 + v)', () => {
    expect(extractIncludedVat(109, 9)).toBe(9);
    expect(extractIncludedVat(60, 9)).toBe(4.95); // spec: ≈ €4.95
    expect(extractIncludedVat(100, 19)).toBe(15.97);
    expect(extractIncludedVat(20, 9)).toBe(1.65);
  });

  it('defaults to 9% VAT', () => {
    expect(extractIncludedVat(60)).toBe(4.95);
  });

  it.each([
    [60, 0],
    [60, -9],
    [0, 9],
    [-10, 9],
  ])('returns 0 for gross=%f vat=%f (nothing to extract)', (gross, vat) => {
    expect(extractIncludedVat(gross, vat)).toBe(0);
  });
});

describe('applyMinimumFare', () => {
  it('lifts a fare below the minimum and reports the adjustment', () => {
    expect(applyMinimumFare(15, 20)).toEqual({
      fareBeforeFees: 20,
      minimumFareAdjustment: 5,
      minimumFareApplied: true,
    });
  });

  it('does not touch a fare exactly at the minimum', () => {
    expect(applyMinimumFare(20, 20)).toEqual({
      fareBeforeFees: 20,
      minimumFareAdjustment: 0,
      minimumFareApplied: false,
    });
  });

  it('does not touch a fare above the minimum', () => {
    expect(applyMinimumFare(25.5, 20)).toEqual({
      fareBeforeFees: 25.5,
      minimumFareAdjustment: 0,
      minimumFareApplied: false,
    });
  });

  it('handles zero and negative actual fares', () => {
    expect(applyMinimumFare(0, 20)).toMatchObject({
      fareBeforeFees: 20,
      minimumFareAdjustment: 20,
      minimumFareApplied: true,
    });
    expect(applyMinimumFare(-5, 20)).toMatchObject({
      fareBeforeFees: 20,
      minimumFareAdjustment: 25,
      minimumFareApplied: true,
    });
  });

  it('reports no adjustment when the gap is under half a cent', () => {
    // 19.999 is lifted to 20.00, but the 0.001 gap rounds to a 0.00 adjustment.
    expect(applyMinimumFare(19.999, 20)).toEqual({
      fareBeforeFees: 20,
      minimumFareAdjustment: 0,
      minimumFareApplied: false,
    });
  });
});

describe('isDayFareTime (Day 06:00:00–20:29:59, Night 20:30:00–05:59:59)', () => {
  it.each([
    ['06:00', true],
    ['06:00:00', true],
    ['06:00:01', true],
    ['12:00', true],
    ['20:29', true],
    ['20:29:59', true],
    ['6:00', true], // un-padded hour
  ])('%s is DAY', (time, expected) => {
    expect(isDayFareTime(time)).toBe(expected);
  });

  it.each([
    ['05:59', false],
    ['05:59:59', false],
    ['00:00', false],
    ['03:15', false],
    ['20:30', false],
    ['20:30:00', false],
    ['20:30:01', false],
    ['23:59', false],
    ['23:59:59', false],
    ['24:00', false], // end of day = night
  ])('%s is NIGHT', (time, expected) => {
    expect(isDayFareTime(time)).toBe(expected);
  });

  it('treats unparseable input as NIGHT (fails toward the higher rate, never throws)', () => {
    expect(isDayFareTime('abc')).toBe(false);
    expect(isDayFareTime('')).toBe(false);
    expect(isDayFareTime('ab:cd')).toBe(false);
  });

  it('throws a TypeError for null/undefined input', () => {
    expect(() => isDayFareTime(undefined as unknown as string)).toThrow(TypeError);
    expect(() => isDayFareTime(null as unknown as string)).toThrow(TypeError);
  });
});

describe('isDayFareDateTime (uses the RIDE time zone, not the server clock)', () => {
  // Europe/Nicosia: UTC+2 in winter (EET), UTC+3 in summer (EEST).
  it('winter: 04:00Z is 06:00 EET -> day; 03:59:59Z is 05:59:59 -> night', () => {
    expect(isDayFareDateTime(new Date('2026-01-15T04:00:00Z'))).toBe(true);
    expect(isDayFareDateTime(new Date('2026-01-15T03:59:59Z'))).toBe(false);
  });

  it('winter: 18:29:59Z is 20:29:59 EET -> day; 18:30:00Z is 20:30 -> night', () => {
    expect(isDayFareDateTime(new Date('2026-01-15T18:29:59Z'))).toBe(true);
    expect(isDayFareDateTime(new Date('2026-01-15T18:30:00Z'))).toBe(false);
  });

  it('summer (DST, UTC+3): boundaries shift by one hour in UTC', () => {
    expect(isDayFareDateTime(new Date('2026-07-15T03:00:00Z'))).toBe(true); // 06:00 EEST
    expect(isDayFareDateTime(new Date('2026-07-15T02:59:59Z'))).toBe(false);
    expect(isDayFareDateTime(new Date('2026-07-15T17:29:59Z'))).toBe(true); // 20:29:59 EEST
    expect(isDayFareDateTime(new Date('2026-07-15T17:30:00Z'))).toBe(false);
  });

  it('follows RIDE_TIME_ZONE when it changes (Asia/Dhaka = UTC+6, no DST)', () => {
    useRideTimeZone('Asia/Dhaka');
    // 00:00Z = 06:00 Dhaka -> day, although it is 02:00 in Nicosia (night)
    expect(isDayFareDateTime(new Date('2026-01-15T00:00:00Z'))).toBe(true);
    expect(isDayFareDateTime(new Date('2026-01-14T23:59:59Z'))).toBe(false);
  });
});

describe('getDayNightRates', () => {
  const settings = {
    dayFareInitialCharge: 3.8,
    dayFarePerKMRate: 0.95,
    dayFareWaitingCharge: 17,
    nightFareInitialCharge: 4.8,
    nightFarePerKMRate: 1.1,
    nightFareWaitingCharge: 19,
  };

  it('returns day rates inside the day window', () => {
    expect(getDayNightRates('06:00', settings)).toEqual({
      initialCharge: 3.8,
      perKm: 0.95,
      waitingChargePerHour: 17,
    });
    expect(getDayNightRates('20:29', settings).initialCharge).toBe(3.8);
  });

  it('returns night rates outside the day window', () => {
    expect(getDayNightRates('20:30', settings)).toEqual({
      initialCharge: 4.8,
      perKm: 1.1,
      waitingChargePerHour: 19,
    });
    expect(getDayNightRates('05:59', settings).perKm).toBe(1.1);
    expect(getDayNightRates('00:00', settings).waitingChargePerHour).toBe(19);
  });
});

describe('resolveSplitMatchedSurchargePercent (client: 2 riders +30%, 3 riders +50%)', () => {
  it.each([
    [1, 0],
    [2, 30],
    [3, 50],
    [4, 50], // 4+ is not allowed upstream; math saturates at the 3-rider tier
    [10, 50],
  ])('%i active riders -> %i%%', (riders, expected) => {
    expect(resolveSplitMatchedSurchargePercent(riders)).toBe(expected);
  });

  it.each([0, -3, NaN, undefined, null])(
    'treats invalid rider count %s as a single rider (0%%)',
    (riders) => {
      expect(resolveSplitMatchedSurchargePercent(riders as number)).toBe(0);
    },
  );

  it('honours admin-configured percentages', () => {
    expect(resolveSplitMatchedSurchargePercent(2, 25, 45)).toBe(25);
    expect(resolveSplitMatchedSurchargePercent(3, 25, 45)).toBe(45);
    expect(resolveSplitMatchedSurchargePercent(1, 25, 45)).toBe(0);
  });
});

describe('buildPassengerFareTotals', () => {
  describe('private ride (spec §1)', () => {
    it('day, 50 km, 1 seat -> passenger pays €60 with €4.95 VAT included', () => {
      const t = buildPassengerFareTotals(baseInput);
      expect(t.actualFare).toBe(51.3);
      expect(t.fareBeforeFees).toBe(56.43); // after +10% PMC
      expect(t.bracketRoundedFare).toBe(60);
      expect(t.totalFare).toBe(60);
      expect(t.minimumFareApplied).toBe(false);
      expect(t.minimumFareAdjustment).toBe(0);
      expect(t.vatAmount).toBe(4.95);
      expect(t.netBeforeVat).toBe(55.05);
      expect(t.vatIncluded).toBe(true);
      expect(t.platformVatPercent).toBe(9);
    });

    it('hides the platform commission from the rider-facing breakdown', () => {
      const t = buildPassengerFareTotals(baseInput);
      expect(t.platformCommissionPercent).toBe(0);
      expect(t.platformCommissionAmount).toBe(0);
      expect(t.fareBeforePlatformCommission).toBe(51.3);
    });

    it('has no split surcharge', () => {
      const t = buildPassengerFareTotals(baseInput);
      expect(t.splitRideMatchedSurchargePercent).toBe(0);
      expect(t.splitRideMatchedSurchargeAmount).toBe(0);
      expect(t.splitSurchargePercent).toBe(0);
      expect(t.splitSurchargeAmount).toBe(0);
    });

    it('applies the €20 minimum fare to short rides', () => {
      // 5.00 -> 5.50 after PMC -> €10 bracket -> lifted to €20
      const t = buildPassengerFareTotals({ ...baseInput, rawComponentFare: 5 });
      expect(t.bracketRoundedFare).toBe(10);
      expect(t.totalFare).toBe(20);
      expect(t.minimumFareApplied).toBe(true);
      expect(t.minimumFareAdjustment).toBe(10);
    });

    it('a price exactly on a €5 bracket is kept; one cent over moves to the next bracket', () => {
      const exact = buildPassengerFareTotals({
        ...baseInput,
        rawComponentFare: 50, // 50 * 1.1 = 55.00 exactly -> stays 55
      });
      expect(exact.totalFare).toBe(55);

      const justOver = buildPassengerFareTotals({
        ...baseInput,
        rawComponentFare: 54.55, // 54.55 * 1.1 = 60.005 -> 60.01 -> 65
      });
      expect(justOver.fareBeforeFees).toBe(60.01);
      expect(justOver.totalFare).toBe(65);
    });

    it('zero fare still charges the minimum', () => {
      const t = buildPassengerFareTotals({ ...baseInput, rawComponentFare: 0 });
      expect(t.totalFare).toBe(20);
      expect(t.minimumFareApplied).toBe(true);
    });

    it('respects a custom baseFare (minimum) of 0', () => {
      const t = buildPassengerFareTotals({
        ...baseInput,
        rawComponentFare: 5,
        baseFare: 0,
      });
      expect(t.totalFare).toBe(10);
      expect(t.minimumFareApplied).toBe(false);
    });

    it('respects a configurable rounding bracket', () => {
      const five = buildPassengerFareTotals({ ...baseInput, rawComponentFare: 40 });
      const ten = buildPassengerFareTotals({
        ...baseInput,
        rawComponentFare: 40,
        fareRoundingBracket: 10,
      });
      expect(five.totalFare).toBe(45); // 40 * 1.1 = 44 -> 45
      expect(ten.totalFare).toBe(50); //             44 -> 50
    });

    it('platformCommissionPercent = 0 cannot disable the mandatory +10%', () => {
      const withZero = buildPassengerFareTotals({
        ...baseInput,
        platformCommissionPercent: 0,
      });
      expect(withZero.totalFare).toBe(60);
    });

    it('honours a different positive commission percent', () => {
      // 51.30 * 1.20 = 61.56 -> 65
      const t = buildPassengerFareTotals({
        ...baseInput,
        platformCommissionPercent: 20,
      });
      expect(t.fareBeforeFees).toBe(61.56);
      expect(t.totalFare).toBe(65);
    });

    it('treats an invalid rider count as a single rider', () => {
      for (const riderCount of [0, -2, NaN, undefined as unknown as number]) {
        expect(
          buildPassengerFareTotals({ ...baseInput, riderCount }).totalFare,
        ).toBe(60);
      }
    });
  });

  describe('split ride', () => {
    const split = (riderCount: number, extra: Partial<typeof baseInput> & Record<string, unknown> = {}) =>
      buildPassengerFareTotals({
        ...baseInput,
        rideType: 'split',
        riderCount,
        splitRideMatchedSurchargePercent:
          riderCount >= 3 ? 50 : riderCount === 2 ? 30 : 0,
        ...extra,
      });

    it('unmatched (alone): priced exactly like a private ride, 0% surcharge (spec: 1st = €60)', () => {
      const t = split(1);
      expect(t.totalFare).toBe(60);
      expect(t.splitRideMatchedSurchargePercent).toBe(0);
      expect(t.splitSurchargeAmount).toBe(0);
    });

    it('2 riders, same route -> €40 each (spec: pool 120, avg 60, +30% = 78, /2 = 39 -> 40)', () => {
      const t = split(2);
      expect(t.fareBeforeFees).toBe(60); // average of initial upfronts
      expect(t.splitRideMatchedSurchargePercent).toBe(30);
      expect(t.splitRideMatchedSurchargeAmount).toBe(18); // 78 - 60
      expect(t.splitSurchargeAmount).toBe(9); // per rider
      expect(t.bracketRoundedFare).toBe(40);
      expect(t.totalFare).toBe(40);
      expect(t.minimumFareApplied).toBe(false);
      expect(t.vatAmount).toBe(3.3); // 40 * 9 / 109
    });

    it('3 riders, same route -> €30 each (spec: pool 180, avg 60, +50% = 90, /3 = 30)', () => {
      const t = split(3);
      expect(t.fareBeforeFees).toBe(60);
      expect(t.splitRideMatchedSurchargePercent).toBe(50);
      expect(t.splitRideMatchedSurchargeAmount).toBe(30); // 90 - 60
      expect(t.splitSurchargeAmount).toBe(10);
      expect(t.totalFare).toBe(30);
    });

    it('spec summary table: a rider’s fare drops 60 -> 40 -> 30 as riders join', () => {
      expect([1, 2, 3].map((n) => split(n).totalFare)).toEqual([60, 40, 30]);
    });

    it('uses the pooled initial upfronts when riders have different routes', () => {
      // Riders with initial upfronts €60 and €30: pool 90, avg 45, *1.30 = 58.5, /2 = 29.25 -> 30
      const t = split(2, { poolKomistraBase: 90 });
      expect(t.fareBeforeFees).toBe(45);
      expect(t.totalFare).toBe(30);
    });

    it('lifts a matched fare to the €20 minimum and flags it', () => {
      // pool 40 (2 x €20), avg 20, *1.3 = 26, /2 = 13 -> 15 -> min 20
      const t = split(2, { poolKomistraBase: 40 });
      expect(t.bracketRoundedFare).toBe(15);
      expect(t.totalFare).toBe(20);
      expect(t.minimumFareApplied).toBe(true);
      expect(t.minimumFareAdjustment).toBe(5);
    });

    it('a matched ride never costs a rider more than riding alone (same route, 2 and 3 riders)', () => {
      for (let km = 0; km <= 300; km += 1.7) {
        const raw = Math.round((3.8 + km * 0.95) * 100) / 100;
        const solo = split(1, { rawComponentFare: raw }).totalFare;
        expect(split(2, { rawComponentFare: raw }).totalFare).toBeLessThanOrEqual(solo);
        expect(split(3, { rawComponentFare: raw }).totalFare).toBeLessThanOrEqual(solo);
      }
    });

    it('rideType=private ignores riderCount (a private ride is always one payer)', () => {
      const t = buildPassengerFareTotals({ ...baseInput, riderCount: 3 });
      expect(t.totalFare).toBe(60);
      expect(t.splitSurchargePercent).toBe(0);
    });
  });

  describe('invariants over a distance sweep', () => {
    const distances = Array.from({ length: 120 }, (_, i) => i * 2.35);

    it.each(['private', 'split'] as const)(
      '%s: total >= minimum, is on a €5 bracket, and VAT + net = total',
      (rideType) => {
        for (const km of distances) {
          for (const riderCount of rideType === 'split' ? [1, 2, 3] : [1]) {
            const raw = Math.round((3.8 + km * 0.95) * 100) / 100;
            const t = buildPassengerFareTotals({
              ...baseInput,
              rideType,
              riderCount,
              rawComponentFare: raw,
              splitRideMatchedSurchargePercent:
                riderCount === 3 ? 50 : riderCount === 2 ? 30 : 0,
            });
            expect(t.totalFare).toBeGreaterThanOrEqual(20);
            expect(Math.round(t.totalFare * 100) % 500).toBe(0);
            expect(roundMoney(t.vatAmount + t.netBeforeVat)).toBe(t.totalFare);
            expect(Number.isFinite(t.totalFare)).toBe(true);
          }
        }
      },
    );
  });
});

describe('buildDriverPayout', () => {
  it('applies platform fee then VAT on the remainder (15% / 19% defaults)', () => {
    expect(buildDriverPayout(100)).toEqual({
      driverGrossAmount: 100,
      driverPlatformFeeAmount: 15,
      driverVatAmount: 16.15, // 19% of 85
      driverEarningAmount: 68.85,
      driverPlatformFeePercent: 15,
      driverVatPercent: 19,
    });
  });

  it('rounds each component to cents', () => {
    const p = buildDriverPayout(33.33, 15, 19);
    expect(p.driverPlatformFeeAmount).toBe(5); // 4.9995
    expect(p.driverVatAmount).toBe(5.38);
    expect(p.driverEarningAmount).toBe(22.95);
  });

  it('clamps a negative gross to zero (no negative earnings)', () => {
    const p = buildDriverPayout(-50);
    expect(p.driverGrossAmount).toBe(0);
    expect(p.driverEarningAmount).toBe(0);
    expect(p.driverPlatformFeeAmount).toBe(0);
    expect(p.driverVatAmount).toBe(0);
  });

  it('0% fee and 0% VAT pays the full gross', () => {
    expect(buildDriverPayout(80, 0, 0).driverEarningAmount).toBe(80);
  });

  it('100% fee leaves nothing for the driver', () => {
    const p = buildDriverPayout(80, 100, 19);
    expect(p.driverEarningAmount).toBe(0);
    expect(p.driverVatAmount).toBe(0);
  });

  it('echoes the percentages it used', () => {
    const p = buildDriverPayout(50, 10, 5);
    expect(p.driverPlatformFeePercent).toBe(10);
    expect(p.driverVatPercent).toBe(5);
  });

  it('fee + VAT + earning always reconciles to the gross (±1 cent rounding)', () => {
    for (let gross = 0; gross <= 500; gross += 3.37) {
      for (const [fee, vat] of [[15, 19], [10, 9], [0, 19], [20, 0]]) {
        const p = buildDriverPayout(gross, fee, vat);
        const sum = p.driverPlatformFeeAmount + p.driverVatAmount + p.driverEarningAmount;
        expect(Math.abs(sum - p.driverGrossAmount)).toBeLessThanOrEqual(0.011);
        expect(p.driverEarningAmount).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('reversePassengerTotalToBase', () => {
  const base = {
    platformCommissionPercent: 10,
    splitRideMatchedSurchargePercent: 30,
  };

  it('private: strips the baked-in +10% (60 -> 54.55)', () => {
    expect(
      reversePassengerTotalToBase({ ...base, totalFare: 60, rideType: 'private', riderCount: 1 }),
    ).toBe(54.55);
  });

  it('split with a single rider reverses like a private ride', () => {
    expect(
      reversePassengerTotalToBase({ ...base, totalFare: 60, rideType: 'split', riderCount: 1 }),
    ).toBe(54.55);
  });

  it('matched split: strips the surcharge percent (40 / 1.3 = 30.77)', () => {
    expect(
      reversePassengerTotalToBase({ ...base, totalFare: 40, rideType: 'split', riderCount: 2 }),
    ).toBe(30.77);
  });

  it('private ignores riderCount', () => {
    expect(
      reversePassengerTotalToBase({ ...base, totalFare: 60, rideType: 'private', riderCount: 5 }),
    ).toBe(54.55);
  });

  it.each([0, -10, NaN])('returns 0 for a non-positive / invalid total (%s)', (totalFare) => {
    expect(
      reversePassengerTotalToBase({ ...base, totalFare, rideType: 'private', riderCount: 1 }),
    ).toBe(0);
  });

  it('commission 0 falls back to the mandatory 10%', () => {
    expect(
      reversePassengerTotalToBase({
        ...base,
        platformCommissionPercent: 0,
        totalFare: 60,
        rideType: 'private',
        riderCount: 1,
      }),
    ).toBe(54.55);
  });

  it('round-trips a private fare to within one €5 bracket (reverse is lossy by design)', () => {
    for (const raw of [20, 33.45, 51.3, 80.1, 150]) {
      const { totalFare } = buildPassengerFareTotals({ ...baseInput, rawComponentFare: raw });
      const back = reversePassengerTotalToBase({
        ...base,
        totalFare,
        rideType: 'private',
        riderCount: 1,
      });
      // never below the original; at most one €5 bracket (net of the +10%) above it
      expect(back).toBeGreaterThanOrEqual(raw - 0.01);
      expect(back - raw).toBeLessThan(5 / 1.1 + 0.01);
    }
  });
});

describe('computeDriverPayoutFromPassengerTotal', () => {
  const settings = {
    driverPlatformFeePercent: 15,
    driverVatPercent: 19,
    platformCommissionPercent: 10,
    splitRideMatchedSurchargePercent: 30,
  };

  it('private €60: gross 54.55 -> fee 8.18, VAT 8.81, driver earns 37.56', () => {
    const r = computeDriverPayoutFromPassengerTotal(60, 'private', settings);
    expect(r.komistraGross).toBe(54.55);
    expect(r.driverGrossAmount).toBe(54.55);
    expect(r.driverPlatformFeeAmount).toBe(8.18);
    expect(r.driverVatAmount).toBe(8.81);
    expect(r.driverEarningAmount).toBe(37.56);
  });

  it('matched split reverses the pooled total with the surcharge setting', () => {
    const r = computeDriverPayoutFromPassengerTotal(80, 'split', settings, true);
    expect(r.komistraGross).toBe(61.54); // 80 / 1.3
    expect(r.driverEarningAmount).toBeGreaterThan(0);
  });

  it('split that is NOT matched reverses like a private ride', () => {
    const r = computeDriverPayoutFromPassengerTotal(60, 'split', settings, false);
    expect(r.komistraGross).toBe(54.55);
  });

  it('zero collected -> zero payout everywhere', () => {
    const r = computeDriverPayoutFromPassengerTotal(0, 'private', settings);
    expect(r).toMatchObject({
      komistraGross: 0,
      driverGrossAmount: 0,
      driverPlatformFeeAmount: 0,
      driverVatAmount: 0,
      driverEarningAmount: 0,
    });
  });

  it('CHARACTERIZATION: any matched split is reversed as a 2-rider ride (30%), the rider count is not an input', () => {
    // 3 riders x €30 = €90 collected. With the 3-rider surcharge (50%) the base would be
    // 90 / 1.5 = €60. The function can only use the 2-rider percent, giving 90 / 1.3.
    // See the BUG-01 handler-level test in driverCompleteTrip for the money impact.
    const r = computeDriverPayoutFromPassengerTotal(
      90,
      'split',
      { ...settings, splitRideMatchedSurchargePercent3: 50 } as typeof settings,
      true,
    );
    expect(r.komistraGross).toBe(69.23);
    expect(r.komistraGross).not.toBe(60);
  });
});
