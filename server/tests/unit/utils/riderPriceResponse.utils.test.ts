/**
 * Unit tests: rider-facing price view (estimated price, VAT 9% included).
 */
import { describe, expect, it } from 'vitest';
import { toRiderPriceView } from '@src/app/utils/riderPriceResponse.utils';

describe('toRiderPriceView', () => {
  it('maps estimatedFare to both estimatedFare and totalFare with VAT included at 9%', () => {
    expect(toRiderPriceView({ estimatedFare: 60, vatAmount: 4.95 })).toEqual({
      estimatedFare: 60,
      totalFare: 60,
      vatIncluded: true,
      vatPercentage: 9,
      vatAmount: 4.95,
    });
  });

  it('falls back to totalFare when estimatedFare is absent', () => {
    const view = toRiderPriceView({ totalFare: 35 });
    expect(view.estimatedFare).toBe(35);
    expect(view.totalFare).toBe(35);
  });

  it('prefers estimatedFare over totalFare when both are given', () => {
    expect(toRiderPriceView({ estimatedFare: 40, totalFare: 99 }).estimatedFare).toBe(40);
  });

  it('keeps an explicit estimatedFare of 0 (?? does not treat 0 as missing)', () => {
    const view = toRiderPriceView({ estimatedFare: 0, totalFare: 99 });
    expect(view.estimatedFare).toBe(0);
    expect(view.totalFare).toBe(0);
  });

  it('defaults to 0 for an empty input', () => {
    expect(toRiderPriceView({})).toEqual({
      estimatedFare: 0,
      totalFare: 0,
      vatIncluded: true,
      vatPercentage: 9,
      vatAmount: 0,
    });
  });

  it('rounds the estimate to exact cents', () => {
    expect(toRiderPriceView({ estimatedFare: 12.345 }).estimatedFare).toBe(12.35);
    expect(toRiderPriceView({ estimatedFare: 0.1 + 0.2 }).estimatedFare).toBe(0.3);
  });

  it('coerces NaN and non-numeric estimates to 0', () => {
    expect(toRiderPriceView({ estimatedFare: NaN }).estimatedFare).toBe(0);
    expect(toRiderPriceView({ estimatedFare: 'abc' as unknown as number }).estimatedFare).toBe(0);
  });

  it('uses vatPercentage when provided and ignores platformVatPercent', () => {
    expect(
      toRiderPriceView({ estimatedFare: 10, vatPercentage: 19, platformVatPercent: 5 }).vatPercentage,
    ).toBe(19);
  });

  it('uses platformVatPercent when vatPercentage is absent', () => {
    expect(toRiderPriceView({ estimatedFare: 10, platformVatPercent: 13 }).vatPercentage).toBe(13);
  });

  it('defaults vatPercentage to 9 for NaN', () => {
    expect(toRiderPriceView({ estimatedFare: 10, vatPercentage: NaN }).vatPercentage).toBe(9);
  });

  it('marks vatIncluded false only when explicitly false', () => {
    expect(toRiderPriceView({ estimatedFare: 10, vatIncluded: false }).vatIncluded).toBe(false);
    expect(toRiderPriceView({ estimatedFare: 10, vatIncluded: true }).vatIncluded).toBe(true);
    expect(toRiderPriceView({ estimatedFare: 10 }).vatIncluded).toBe(true);
  });

  it('rounds vatAmount to exact cents and treats a missing VAT amount as 0', () => {
    expect(toRiderPriceView({ estimatedFare: 60, vatAmount: 4.9541 }).vatAmount).toBe(4.95);
    expect(toRiderPriceView({ estimatedFare: 60 }).vatAmount).toBe(0);
  });

  it('reports a non-zero VAT percentage unchanged', () => {
    expect(toRiderPriceView({ estimatedFare: 10, vatPercentage: 5 }).vatPercentage).toBe(5);
  });
});

describe('KNOWN BUGS - riderPriceResponse.utils', () => {
  // BUG-REPORT FARE-02 | low | server/src/app/utils/riderPriceResponse.utils.ts:16
  // `Number(x) || 9` treats a real 0 as missing, so a configured 0% VAT is shown to riders as 9%.
  // Fix: only fall back when the value is not a finite number (e.g. Number.isFinite check).
  it.fails('BUG FARE-02: reports a configured 0% VAT as 0, not the 9% default', () => {
    expect(toRiderPriceView({ estimatedFare: 10, vatPercentage: 0 }).vatPercentage).toBe(0);
  });
});
