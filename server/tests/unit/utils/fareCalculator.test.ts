/**
 * Unit tests: passenger fare breakdown, settings loading and public-holiday lookup.
 *
 * Expected numbers come from docs/FARE_CALCULATION_PRIVATE_SPLIT.md (day, 50 km):
 *   private 1 seat -> €60, split 2 riders -> €40 each, split 3 riders -> €30 each.
 * Defaults (no Setting rows): day 3.80 + 0.95/km, night 4.80 + 1.10/km, +10% PMC, round up to €5,
 * minimum €20, VAT 9% extracted from the total (total * 9 / 109), 6-seater category +40%.
 * Settings are read through the mocked Setting model; holiday HTTP calls go through a mocked axios.
 */
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockQuery } from '@tests/helpers/mongoose';
import { useRideTimeZone } from '@tests/helpers/time';
import { Setting } from '@src/app/modules/settings/settings.model';
import {
  calculateFareBreakdown,
  isPublicHoliday,
  loadFareSettings,
} from '@src/app/utils/fareCalculator';

vi.mock('@src/app/modules/settings/settings.model', async () => {
  const { createModelMock } = await import('@tests/helpers/modelMock');
  return { Setting: createModelMock() };
});

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

/** Settings rows as the DB would return them (only the keys a test overrides). */
const useSettingRows = (rows: Array<{ key: string; value: unknown }>) => {
  vi.mocked(Setting.find).mockReturnValue(mockQuery(rows) as any);
};

const DAY_9AM = '09:00';
const NIGHT_9PM = '21:00';

const fare = (overrides: Partial<Parameters<typeof calculateFareBreakdown>[0]> = {}) =>
  calculateFareBreakdown({
    distanceKm: 50,
    departureDate: new Date('2026-01-15T07:00:00Z'),
    departureTime: DAY_9AM,
    luggageCount: 0,
    requestedSeats: 1,
    rideType: 'private',
    ...overrides,
  });

beforeEach(() => {
  useRideTimeZone('Europe/Nicosia');
  // Default: no Setting rows, so every rate uses the code default.
  useSettingRows([]);
});

describe('loadFareSettings', () => {
  it('returns the code defaults when no Setting rows exist', async () => {
    const settings = await loadFareSettings();
    expect(settings).toMatchObject({
      dayFareInitialCharge: 3.8,
      dayFarePerKMRate: 0.95,
      dayFareWaitingCharge: 17,
      nightFareInitialCharge: 4.8,
      nightFarePerKMRate: 1.1,
      nightFareWaitingCharge: 19,
      perLuggageCharge: 1.4,
      holidayIncreasePercentage: 20,
      fivePassengerExtraChargePercentage: 20,
      sixPassengerExtraChargePercentage: 40,
      baseFare: 20,
      platformVat: 9,
      platformCommissionPercent: 10,
      splitRideMatchedSurchargePercent: 30,
      splitRideMatchedSurchargePercent3: 50,
      driverPlatformFeePercent: 15,
      driverVatPercent: 19,
      fareRoundingBracket: 5,
    });
  });

  it('queries only the known keys, selecting key and value', async () => {
    await loadFareSettings();
    const finder = vi.mocked(Setting.find).mock.calls[0][0] as unknown as { key: { $in: string[] } };
    expect(finder.key.$in).toEqual(expect.arrayContaining(['baseFare', 'platformVat', 'fareRoundingBracket']));
    expect(finder.key.$in).toHaveLength(18);
  });

  it('overrides defaults with stored values and coerces numeric strings', async () => {
    useSettingRows([
      { key: 'baseFare', value: '25' },
      { key: 'dayFarePerKMRate', value: 1 },
      { key: 'platformCommissionPercent', value: 20 },
    ]);
    const settings = await loadFareSettings();
    expect(settings.baseFare).toBe(25);
    expect(settings.dayFarePerKMRate).toBe(1);
    expect(settings.platformCommissionPercent).toBe(20);
    // Untouched keys keep their defaults.
    expect(settings.dayFareInitialCharge).toBe(3.8);
  });
});

describe('calculateFareBreakdown - private ride (documented example)', () => {
  it('prices a 50 km day private ride for 1 seat at exactly €60', async () => {
    const b = await fare();
    expect(b.totalFare).toBe(60);
    expect(b.bracketRoundedFare).toBe(60);
    expect(b.actualFare).toBe(51.3);
    expect(b.fareBeforeFees).toBe(56.43);
    expect(b.totalKmCharge).toBe(47.5);
    expect(b.initialCharge).toBe(3.8);
    expect(b.perKmCharge).toBe(0.95);
  });

  it('extracts the included VAT as total * 9 / 109 rounded to cents (60 -> 4.95)', async () => {
    const b = await fare();
    expect(b.vat).toBe(4.95);
    expect(b.vatAmount).toBe(4.95);
    expect(b.netBeforeVat).toBe(55.05);
    expect(b.vatIncluded).toBe(true);
  });

  it('reports no split surcharge and no platform commission amount for a private ride', async () => {
    const b = await fare();
    expect(b.splitSurchargePercent).toBe(0);
    expect(b.splitSurchargeAmount).toBe(0);
    expect(b.splitRideMatchedSurchargePercent).toBe(0);
    expect(b.platformCommissionAmount).toBe(0);
    expect(b.platformCommission).toBe(0);
    expect(b.minimumFareApplied).toBe(false);
  });

  it('ignores activeRiderCount for a private ride', async () => {
    const b = await fare({ activeRiderCount: 3 });
    expect(b.totalFare).toBe(60);
    expect(b.splitRideMatchedSurchargePercent).toBe(0);
  });

  it('ignores luggage: luggageCharge stays 0 and the fare does not change', async () => {
    const b = await fare({ luggageCount: 10 });
    expect(b.luggageCharge).toBe(0);
    expect(b.totalFare).toBe(60);
  });
});

describe('calculateFareBreakdown - day / night rates', () => {
  it('uses the night rates at 21:00 (50 km -> 4.80 + 55.00 = 59.80, +10% = 65.78, ceil 70)', async () => {
    const b = await fare({ departureTime: NIGHT_9PM });
    expect(b.initialCharge).toBe(4.8);
    expect(b.perKmCharge).toBe(1.1);
    expect(b.totalKmCharge).toBe(55);
    expect(b.totalFare).toBe(70);
    expect(b.vat).toBe(5.78);
  });

  it('still uses the day rates at 20:29 (last day minute)', async () => {
    const b = await fare({ departureTime: '20:29' });
    expect(b.initialCharge).toBe(3.8);
    expect(b.totalFare).toBe(60);
  });

  it('switches to the night rates at 20:30 (first night minute)', async () => {
    const b = await fare({ departureTime: '20:30' });
    expect(b.initialCharge).toBe(4.8);
    expect(b.totalFare).toBe(70);
  });
});

describe('calculateFareBreakdown - minimum fare and bracket boundaries', () => {
  it('applies the €20 minimum to a zero-distance ride (base 3.80 -> 4.18 -> bracket 5 -> 20)', async () => {
    const b = await fare({ distanceKm: 0 });
    expect(b.bracketRoundedFare).toBe(5);
    expect(b.totalFare).toBe(20);
    expect(b.minimumFareApplied).toBe(true);
    expect(b.minimumFareAdjustment).toBe(15);
    expect(b.minimumFareAmount).toBe(20);
    expect(b.fareBeforeFees).toBe(4.18);
  });

  it('does not flag the minimum when the bracket already equals €20 (boundary 17.56 -> 20)', async () => {
    // 12.8 km -> regulated 15.96 -> +10% 17.56 -> ceil to €20: exactly the minimum.
    const b = await fare({ distanceKm: 12.8 });
    expect(b.fareBeforeFees).toBe(17.56);
    expect(b.bracketRoundedFare).toBe(20);
    expect(b.totalFare).toBe(20);
    expect(b.minimumFareApplied).toBe(false);
    expect(b.minimumFareAdjustment).toBe(0);
  });

  it('CHARACTERIZATION: a negative distance is not rejected and collapses to the €20 minimum', async () => {
    // Surprising: distance validation is expected upstream; here -5 km yields totalKmCharge -4.75.
    const b = await fare({ distanceKm: -5 });
    expect(b.totalKmCharge).toBe(-4.75);
    expect(b.totalFare).toBe(20);
  });

  it('CHARACTERIZATION: a NaN distance is coerced to 0 km and priced at the €20 minimum', async () => {
    const b = await fare({ distanceKm: NaN });
    expect(b.totalKmCharge).toBe(0);
    expect(b.totalFare).toBe(20);
  });
});

describe('calculateFareBreakdown - rounding to exact cents', () => {
  it('rounds the per-km charge to cents (1.234 km * 0.95 = 1.1723 -> 1.17)', async () => {
    const b = await fare({ distanceKm: 1.234 });
    expect(b.totalKmCharge).toBe(1.17);
  });

  it('keeps totalKmCharge and VAT at two decimals for a non-round distance', async () => {
    const b = await fare({ distanceKm: 33.33 });
    // 33.33 * 0.95 = 31.6635 -> 31.66 ; regulated 35.46 ; *1.1 = 39.006 -> 39.01 ; ceil 40
    expect(b.totalKmCharge).toBe(31.66);
    expect(b.totalFare).toBe(40);
    expect(b.vat).toBe(3.3);
    expect(Number.isInteger(Math.round(b.totalFare * 100))).toBe(true);
  });
});

describe('calculateFareBreakdown - waiting time', () => {
  it('adds no waiting charge when waitingMinutes is 0 (default)', async () => {
    const b = await fare();
    expect(b.waitingCharge).toBe(0);
  });

  it('adds the day hourly rate pro-rata: 30 min at 17/h = 8.50 -> 59.80 -> +10% -> 70', async () => {
    const b = await fare({ waitingMinutes: 30 });
    expect(b.waitingCharge).toBe(8.5);
    expect(b.totalFare).toBe(70);
  });

  it('uses the night hourly rate for a night departure (10 min at 19/h = 3.17)', async () => {
    const b = await fare({ departureTime: NIGHT_9PM, waitingMinutes: 10 });
    expect(b.waitingCharge).toBe(3.17);
  });

  it('ignores negative waiting minutes', async () => {
    const b = await fare({ waitingMinutes: -15 });
    expect(b.waitingCharge).toBe(0);
    expect(b.totalFare).toBe(60);
  });

  it('CHARACTERIZATION: waiting is billed from the first minute here (no 2-minute grace as in waitingCharge.utils)', async () => {
    const b = await fare({ waitingMinutes: 1 });
    expect(b.waitingCharge).toBe(0.28);
  });
});

describe('calculateFareBreakdown - 5-6 passenger (6-seater category) uplift', () => {
  it('adds no uplift for 4 passengers (boundary below)', async () => {
    const b = await fare({ requestedSeats: 4 });
    expect(b.sixPassengerExtraCharge).toBe(0);
    expect(b.passengerCountExtra).toBe(0);
    expect(b.sixPassengerExtraChargePercentage).toBe(0);
    expect(b.totalFare).toBe(60);
  });

  it('applies +40% to the regulated base for 5 passengers (boundary above)', async () => {
    const b = await fare({ requestedSeats: 5 });
    // 51.30 * 1.4 = 71.82 ; uplift 20.52 ; *1.1 = 79.00 -> 80
    expect(b.sixPassengerExtraCharge).toBe(20.52);
    expect(b.passengerCountExtra).toBe(20.52);
    expect(b.sixPassengerExtraChargePercentage).toBe(40);
    expect(b.totalFare).toBe(80);
  });

  it('applies the same uplift for 6 passengers', async () => {
    const b = await fare({ requestedSeats: 6 });
    expect(b.sixPassengerExtraCharge).toBe(20.52);
    expect(b.totalFare).toBe(80);
  });

  it('keeps the fivePassengerExtraCharge fields at 0 (the 20% five-seat setting is not used)', async () => {
    const b = await fare({ requestedSeats: 5 });
    expect(b.fivePassengerExtraCharge).toBe(0);
    expect(b.fivePassengerExtraChargePercentage).toBe(0);
  });
});

describe('calculateFareBreakdown - split rides', () => {
  it('prices an unmatched split (1 active rider) as a private ride: €60, no surcharge', async () => {
    const b = await fare({ rideType: 'split', activeRiderCount: 1 });
    expect(b.totalFare).toBe(60);
    expect(b.splitSurchargePercent).toBe(0);
    expect(b.splitSurchargeAmount).toBe(0);
  });

  it('treats a missing or NaN activeRiderCount as 1 rider', async () => {
    expect((await fare({ rideType: 'split' })).totalFare).toBe(60);
    expect((await fare({ rideType: 'split', activeRiderCount: NaN })).totalFare).toBe(60);
  });

  it('matches 2 riders at +30%: pool 120 -> avg 60 -> 78 -> 39 per rider -> €40 each', async () => {
    const b = await fare({ rideType: 'split', activeRiderCount: 2 });
    expect(b.totalFare).toBe(40);
    expect(b.fareBeforeFees).toBe(60);
    expect(b.bracketRoundedFare).toBe(40);
    expect(b.splitRideMatchedSurchargePercent).toBe(30);
    expect(b.splitRideMatchedSurchargeAmount).toBe(18);
    expect(b.splitSurchargePercent).toBe(30);
    expect(b.splitSurchargeAmount).toBe(9);
    expect(b.vat).toBe(3.3);
  });

  it('matches 3 riders at +50%: pool 180 -> avg 60 -> 90 -> 30 per rider -> €30 each', async () => {
    const b = await fare({ rideType: 'split', activeRiderCount: 3 });
    expect(b.totalFare).toBe(30);
    expect(b.splitRideMatchedSurchargePercent).toBe(50);
    expect(b.splitRideMatchedSurchargeAmount).toBe(30);
  });

  it('CHARACTERIZATION: 5 active riders keep the 50% tier but divide the shared basis by 5 (60 -> 90 / 5 = 18 -> €20)', async () => {
    // Docs say 4+ riders are not allowed; the calculator does not enforce that and quotes a lower
    // per-rider fare than the 3-rider price. Presumably the caller rejects 4+ matched riders.
    const b = await fare({ rideType: 'split', activeRiderCount: 5 });
    expect(b.splitRideMatchedSurchargePercent).toBe(50);
    expect(b.totalFare).toBe(20);
  });

  it('uses the stored 2-rider and 3-rider surcharge settings when they are overridden', async () => {
    useSettingRows([
      { key: 'splitRideMatchedSurchargePercent', value: 20 },
      { key: 'splitRideMatchedSurchargePercent3', value: 40 },
    ]);
    const b = await fare({ rideType: 'split', activeRiderCount: 2 });
    // avg 60 * 1.2 = 72 -> per rider 36 -> ceil 40
    expect(b.splitRideMatchedSurchargePercent).toBe(20);
    expect(b.totalFare).toBe(40);
    const three = await fare({ rideType: 'split', activeRiderCount: 3 });
    // avg 60 * 1.4 = 84 -> per rider 28 -> ceil 30
    expect(three.splitRideMatchedSurchargePercent).toBe(40);
    expect(three.totalFare).toBe(30);
  });
});

describe('calculateFareBreakdown - stored settings flow through', () => {
  it('uses a stored baseFare as the minimum fare (zero distance -> 25)', async () => {
    useSettingRows([{ key: 'baseFare', value: '25' }]);
    const b = await fare({ distanceKm: 0 });
    expect(b.baseFare).toBe(25);
    expect(b.minimumFareAmount).toBe(25);
    expect(b.totalFare).toBe(25);
  });

  it('uses a stored platform commission (20%) in the +PMC step: 51.30 * 1.2 = 61.56 -> 65', async () => {
    useSettingRows([{ key: 'platformCommissionPercent', value: 20 }]);
    const b = await fare();
    expect(b.fareBeforeFees).toBe(61.56);
    expect(b.totalFare).toBe(65);
  });

  it('reports the stored VAT percentage in the breakdown', async () => {
    useSettingRows([{ key: 'platformVat', value: 19 }]);
    const b = await fare();
    expect(b.platformVatPercent).toBe(19);
    // 60 * 19 / 119 = 9.5798 -> 9.58
    expect(b.vat).toBe(9.58);
  });
});

describe('isPublicHoliday', () => {
  const get = vi.mocked(axios.get);

  it('returns true for a date listed by the holiday API and caches the year', async () => {
    get.mockResolvedValue({ data: [{ date: '2027-01-01' }, { date: '2027-03-25' }] });
    // 2027-01-01 10:00Z is 12:00 on 1 Jan in Nicosia
    expect(await isPublicHoliday(new Date('2027-01-01T10:00:00Z'))).toBe(true);
    expect(await isPublicHoliday(new Date('2027-03-25T10:00:00Z'))).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('https://date.nager.at/api/v3/PublicHolidays/2027/CY');
  });

  it('returns false for an ordinary date in the same year', async () => {
    get.mockResolvedValue({ data: [{ date: '2027-01-01' }] });
    expect(await isPublicHoliday(new Date('2027-01-02T10:00:00Z'))).toBe(false);
  });

  it('uses the Nicosia calendar day at the local midnight boundary', async () => {
    get.mockResolvedValue({ data: [{ date: '2029-01-01' }] });
    // 2028-12-31 22:00Z is 00:00 on 1 Jan 2029 in Nicosia (winter)
    expect(await isPublicHoliday(new Date('2028-12-31T22:00:00Z'))).toBe(true);
    // one second earlier is still 31 Dec
    expect(await isPublicHoliday(new Date('2028-12-31T21:59:59Z'))).toBe(false);
  });

  it('queries the Bangladesh holiday list when the ride zone is Asia/Dhaka', async () => {
    useRideTimeZone('Asia/Dhaka');
    get.mockResolvedValue({ data: [{ date: '2030-02-21' }] });
    expect(await isPublicHoliday(new Date('2030-02-21T05:00:00Z'))).toBe(true);
    expect(get).toHaveBeenCalledWith('https://date.nager.at/api/v3/PublicHolidays/2030/BD');
  });

  it('returns false (no throw) and does not cache when the holiday API fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    get.mockRejectedValue(new Error('network down'));
    expect(await isPublicHoliday(new Date('2032-06-01T10:00:00Z'))).toBe(false);
    expect(warn).toHaveBeenCalled();

    // Not cached: a later call retries the API.
    get.mockResolvedValue({ data: [{ date: '2032-06-01' }] });
    expect(await isPublicHoliday(new Date('2032-06-01T10:00:00Z'))).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('treats a non-array API payload as a failure and returns false', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    get.mockResolvedValue({ data: { message: 'rate limited' } });
    expect(await isPublicHoliday(new Date('2031-05-05T10:00:00Z'))).toBe(false);
  });
});
