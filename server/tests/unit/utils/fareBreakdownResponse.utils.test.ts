/**
 * Unit tests: fare breakdown rebuilt from a stored passenger (buildStoredFareBreakdown).
 *
 * The Setting model is mocked; each test supplies the settings rows it relies on. Stored passenger
 * components are the values persisted at booking time (initialCharge, totalKmCharge, ...).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockQuery } from '@tests/helpers/mongoose';
import { Setting } from '@src/app/modules/settings/settings.model';
import { buildStoredFareBreakdown } from '@src/app/utils/fareBreakdownResponse.utils';

vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
});

/** Settings used by a typical deployment (same values as the code defaults, baseFare 20). */
const STANDARD_ROWS = [
  { key: 'platformVat', value: 9 },
  { key: 'platformCommissionPercent', value: 10 },
  { key: 'baseFare', value: 20 },
  { key: 'fivePassengerExtraChargePercentage', value: 20 },
  { key: 'sixPassengerExtraChargePercentage', value: 40 },
  { key: 'splitRideMatchedSurchargePercent', value: 30 },
  { key: 'fareRoundingBracket', value: 5 },
];

const useRows = (rows: Array<{ key: string; value: unknown }>) => {
  vi.mocked(Setting.find).mockReturnValue(mockQuery(rows) as any);
};

/** A 50 km day private passenger as stored at booking time (initial 3.80 + 47.50 km). */
const privatePassenger = (extra: Record<string, unknown> = {}) => ({
  initialCharge: 3.8,
  perKmCharge: 0.95,
  totalKmCharge: 47.5,
  waitingCharge: 0,
  fivePassengerCharge: 0,
  sixPassengerCharge: 0,
  rideId: { type: 'private' },
  ...extra,
});

/** A matched 2-rider split passenger: 60 average initial + 9 per-passenger surcharge share. */
const matchedSplitPassenger = (extra: Record<string, unknown> = {}) => ({
  initialCharge: 3.8,
  totalKmCharge: 47.5,
  surchargeAmount: 9,
  surchargePercent: 30,
  rideId: { type: 'split', currentSurchargePercent: 30 },
  ...extra,
});

beforeEach(() => {
  useRows(STANDARD_ROWS);
});

describe('buildStoredFareBreakdown - private passenger', () => {
  it('rebuilds the documented 50 km private fare of €60 from stored components', async () => {
    const b = await buildStoredFareBreakdown(privatePassenger());
    expect(b.totalFare).toBe(60);
    expect(b.estimatedFare).toBe(60);
    expect(b.actualFare).toBe(51.3);
    expect(b.fareBeforeFees).toBe(56.43);
    expect(b.baseFare).toBe(20);
  });

  it('extracts VAT from the total at 9% included (60 -> 4.95, net 55.05)', async () => {
    const b = await buildStoredFareBreakdown(privatePassenger());
    expect(b.vat).toBe(4.95);
    expect(b.vatAmount).toBe(4.95);
    expect(b.vatPercentage).toBe(9);
    expect(b.platformVatPercent).toBe(9);
    expect(b.netBeforeVat).toBe(55.05);
    expect(b.vatIncluded).toBe(true);
  });

  it('reports the platform commission as 0 for rider display (amount and percent)', async () => {
    const b = await buildStoredFareBreakdown(privatePassenger());
    expect(b.platformCommissionAmount).toBe(0);
    expect(b.platformCommission).toBe(0);
    expect(b.platformCommissionPercentage).toBe(0);
  });

  it('reports no split surcharge for a private ride even if surcharge fields are stored', async () => {
    const b = await buildStoredFareBreakdown(privatePassenger({ surchargeAmount: 9, surchargePercent: 30 }));
    expect(b.splitSurchargeAmount).toBe(0);
    expect(b.splitRideMatchedSurchargePercent).toBe(0);
    expect(b.totalFare).toBe(60);
  });

  it('uses the stored booking total for a private ride when present (non-zero)', async () => {
    const b = await buildStoredFareBreakdown(privatePassenger({ totalFare: 65 }));
    expect(b.totalFare).toBe(65);
    expect(b.estimatedFare).toBe(65);
  });

  it('falls back to the booking.totalFare when the passenger has none', async () => {
    const b = await buildStoredFareBreakdown(privatePassenger(), { totalFare: 70 });
    expect(b.totalFare).toBe(70);
  });

  it('ignores a stored total of 0 and recomputes the fare', async () => {
    const b = await buildStoredFareBreakdown(privatePassenger({ totalFare: 0 }), { totalFare: 0 });
    expect(b.totalFare).toBe(60);
  });

  it('CHARACTERIZATION: a stored total that differs from the recomputed one keeps VAT from the recomputed fare', async () => {
    // The shown total is 75 but VAT 4.95 and net 55.05 are from the 60 recomputation: they do not add up to 75.
    const b = await buildStoredFareBreakdown(privatePassenger({ totalFare: 75 }));
    expect(b.totalFare).toBe(75);
    expect(b.vat).toBe(4.95);
    expect(b.netBeforeVat).toBe(55.05);
  });

  it('carries the stored component charges through unchanged', async () => {
    const b = await buildStoredFareBreakdown(
      privatePassenger({ waitingCharge: 8.5, fivePassengerCharge: 0, sixPassengerCharge: 20.52 }),
    );
    expect(b.waitingCharge).toBe(8.5);
    expect(b.sixPassengerExtraCharge).toBe(20.52);
    expect(b.passengerCountExtra).toBe(20.52);
    expect(b.luggageCharge).toBe(0);
    expect(b.holidaySurcharge).toBe(0);
    expect(b.initialCharge).toBe(3.8);
    expect(b.perKmCharge).toBe(0.95);
    expect(b.totalKmCharge).toBe(47.5);
  });

  it('rounds stored components to cents', async () => {
    const b = await buildStoredFareBreakdown(privatePassenger({ totalKmCharge: 47.4949 }));
    expect(b.totalKmCharge).toBe(47.49);
  });

  it('treats missing stored components as 0 without throwing', async () => {
    const b = await buildStoredFareBreakdown({ rideId: { type: 'private' } });
    expect(b.initialCharge).toBe(0);
    expect(b.totalKmCharge).toBe(0);
    // Raw fare 0 -> PMC 0 -> bracket 0 -> max(0, baseFare 20) = 20
    expect(b.totalFare).toBe(20);
  });

  it('uses the stored-setting fallbacks (platform VAT 9%, PMC 10%) when settings are absent', async () => {
    useRows([]);
    const b = await buildStoredFareBreakdown(privatePassenger());
    expect(b.vatPercentage).toBe(9);
    expect(b.totalFare).toBe(60);
  });

  it('CHARACTERIZATION: with no baseFare setting the minimum fare is 0, not the €20 used elsewhere', async () => {
    useRows([{ key: 'platformVat', value: 9 }]);
    const b = await buildStoredFareBreakdown(privatePassenger({ initialCharge: 0, totalKmCharge: 0 }));
    expect(b.baseFare).toBe(0);
    expect(b.totalFare).toBe(0);
  });

  it('queries the seven expected settings keys', async () => {
    await buildStoredFareBreakdown(privatePassenger());
    const filter = vi.mocked(Setting.find).mock.calls[0][0] as unknown as { key: { $in: string[] } };
    expect(filter.key.$in).toEqual([
      'platformVat',
      'platformCommissionPercent',
      'baseFare',
      'fivePassengerExtraChargePercentage',
      'sixPassengerExtraChargePercentage',
      'splitRideMatchedSurchargePercent',
      'fareRoundingBracket',
    ]);
  });
});

describe('buildStoredFareBreakdown - split passenger', () => {
  it('prices a split passenger without a stored surcharge as a single fare (€60)', async () => {
    const b = await buildStoredFareBreakdown({
      initialCharge: 3.8,
      totalKmCharge: 47.5,
      rideId: { type: 'split' },
    });
    expect(b.totalFare).toBe(60);
    expect(b.splitSurchargeAmount).toBe(0);
  });

  it('CHARACTERIZATION: an unmatched split passenger still reports the default 30% surcharge percent with a 0 amount', async () => {
    // Surprising: the percent falls back to the 30% default for every split, while the amount is 0.
    const b = await buildStoredFareBreakdown({
      initialCharge: 3.8,
      totalKmCharge: 47.5,
      rideId: { type: 'split' },
    });
    expect(b.splitSurchargePercent).toBe(30);
    expect(b.splitRideMatchedSurchargeAmount).toBe(0);
  });

  it('reports the stored surcharge percent and amount for a matched split passenger', async () => {
    const b = await buildStoredFareBreakdown(matchedSplitPassenger());
    expect(b.splitSurchargePercent).toBe(30);
    expect(b.splitRideMatchedSurchargePercent).toBe(30);
    expect(b.splitSurchargeAmount).toBe(9);
    expect(b.splitRideMatchedSurchargeAmount).toBe(9);
    expect(b.fareBeforeFees).toBe(60);
  });

  it('falls back to the ride currentSurchargePercent when the passenger has no surchargePercent', async () => {
    const b = await buildStoredFareBreakdown(
      matchedSplitPassenger({ surchargePercent: undefined, rideId: { type: 'split', currentSurchargePercent: 50 } }),
    );
    expect(b.splitSurchargePercent).toBe(50);
  });

  it('uses the ride passed explicitly when it is an object with a type', async () => {
    const b = await buildStoredFareBreakdown(
      { initialCharge: 3.8, totalKmCharge: 47.5, surchargeAmount: 0 },
      undefined,
      { type: 'split' },
    );
    // type split but no surcharge stored -> not matched, so the total is the unmatched fare
    expect(b.totalFare).toBe(60);
  });
});

describe('KNOWN BUGS - fareBreakdownResponse.utils', () => {
  // BUG-REPORT FARE-05 | high | server/src/app/utils/fareBreakdownResponse.utils.ts:97
  // For a stored matched split the total is recomputed as fareBeforeFees (average initial, 60) plus the
  // per-passenger surcharge share (9) = 69, and the stored passenger.totalFare (40, the documented
  // per-rider fare after recalculation) is ignored (only non-split bookings use it). Riders see a price
  // different from the one charged. Fix: for stored matched splits use passenger.totalFare when present.
  it.fails('BUG FARE-05: a matched 2-rider passenger shows the stored per-rider total of 40', async () => {
    const b = await buildStoredFareBreakdown(matchedSplitPassenger({ totalFare: 40 }));
    expect(b.totalFare).toBe(40);
    expect(b.estimatedFare).toBe(40);
  });
});
