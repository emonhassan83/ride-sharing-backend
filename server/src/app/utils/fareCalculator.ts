// utils/fareCalculator.ts
import { Setting } from '../modules/settings/settings.model';
import axios from 'axios';
import {
  buildPassengerFareTotals,
  getDayNightRates,
  roundMoney,
} from './fareMath.utils';

export interface FareBreakdown {
  initialCharge: number;
  perKmCharge: number;
  totalKmCharge: number;
  luggageCharge: number;
  passengerCountExtra: number;
  holidaySurcharge: number;
  waitingCharge: number;
  fivePassengerExtraCharge: number;
  sixPassengerExtraCharge: number;
  fivePassengerExtraChargePercentage: number;
  sixPassengerExtraChargePercentage: number;
  baseFare: number;
  actualFare: number;
  fareBeforeFees: number;
  vat: number;
  vatIncluded: boolean;
  netBeforeVat: number;
  minimumFareApplied: boolean;
  minimumFareAmount: number;
  minimumFareAdjustment: number;
  splitSurchargePercent: number;
  splitSurchargeAmount: number;
  splitRideMatchedSurchargePercent: number;
  splitRideMatchedSurchargeAmount: number;
  fareBeforePlatformCommission: number;
  platformVatPercent: number;
  vatAmount: number;
  platformCommissionPercent: number;
  platformCommission: number;
  platformCommissionAmount: number;
  bracketRoundedFare: number;
  totalFare: number;
}

interface FareSettings {
  dayFareInitialCharge: number;
  dayFarePerKMRate: number;
  dayFareWaitingCharge: number;
  nightFareInitialCharge: number;
  nightFarePerKMRate: number;
  nightFareWaitingCharge: number;
  perLuggageCharge: number;
  holidayIncreasePercentage: number;
  fivePassengerExtraChargePercentage: number;
  sixPassengerExtraChargePercentage: number;
  baseFare: number;
  platformVat: number;
  platformCommissionPercent: number;
  splitRideMatchedSurchargePercent: number;
  driverPlatformFeePercent: number;
  driverVatPercent: number;
  fareRoundingBracket: number;
}

const DEFAULTS: FareSettings = {
  dayFareInitialCharge: 3.8,
  dayFarePerKMRate: 0.95,
  dayFareWaitingCharge: 17.0,
  nightFareInitialCharge: 4.8,
  nightFarePerKMRate: 1.1,
  nightFareWaitingCharge: 19.0,
  perLuggageCharge: 2.0,
  holidayIncreasePercentage: 20,
  fivePassengerExtraChargePercentage: 20,
  sixPassengerExtraChargePercentage: 40,
  baseFare: 20,
  platformVat: 9,
  platformCommissionPercent: 10,
  splitRideMatchedSurchargePercent: 30,
  driverPlatformFeePercent: 15,
  driverVatPercent: 19,
  fareRoundingBracket: 5,
};

let holidaysCache: { [year: string]: string[] } = {};

async function getCyprusPublicHolidays(year: number): Promise<string[]> {
  const cacheKey = year.toString();

  if (holidaysCache[cacheKey]) {
    return holidaysCache[cacheKey];
  }

  try {
    const response = await axios.get(
      `https://date.nager.at/api/v3/PublicHolidays/${year}/CY`,
    );

    const holidays = response.data.map((h: any) => h.date);
    holidaysCache[cacheKey] = holidays;

    return holidays;
  } catch (error) {
    console.warn(`Failed to fetch holidays for ${year}, using fallback`);
    return [];
  }
}

export async function isPublicHoliday(date: Date): Promise<boolean> {
  const year = date.getFullYear();
  const dateStr = date.toISOString().split('T')[0];

  const holidays = await getCyprusPublicHolidays(year);
  return holidays.includes(dateStr);
}

export async function loadFareSettings(): Promise<FareSettings> {
  const keys = Object.keys(DEFAULTS);
  const docs = await Setting.find({ key: { $in: keys } }).select('key value').lean();

  const map = new Map(docs.map((d) => [d.key, Number(d.value)]));

  return {
    dayFareInitialCharge: map.get('dayFareInitialCharge') ?? DEFAULTS.dayFareInitialCharge,
    dayFarePerKMRate: map.get('dayFarePerKMRate') ?? DEFAULTS.dayFarePerKMRate,
    dayFareWaitingCharge: map.get('dayFareWaitingCharge') ?? DEFAULTS.dayFareWaitingCharge,
    nightFareInitialCharge: map.get('nightFareInitialCharge') ?? DEFAULTS.nightFareInitialCharge,
    nightFarePerKMRate: map.get('nightFarePerKMRate') ?? DEFAULTS.nightFarePerKMRate,
    nightFareWaitingCharge: map.get('nightFareWaitingCharge') ?? DEFAULTS.nightFareWaitingCharge,
    perLuggageCharge: map.get('perLuggageCharge') ?? DEFAULTS.perLuggageCharge,
    holidayIncreasePercentage: map.get('holidayIncreasePercentage') ?? DEFAULTS.holidayIncreasePercentage,
    fivePassengerExtraChargePercentage:
      map.get('fivePassengerExtraChargePercentage') ?? DEFAULTS.fivePassengerExtraChargePercentage,
    sixPassengerExtraChargePercentage:
      map.get('sixPassengerExtraChargePercentage') ?? DEFAULTS.sixPassengerExtraChargePercentage,
    baseFare: map.get('baseFare') ?? DEFAULTS.baseFare,
    platformVat: map.get('platformVat') ?? DEFAULTS.platformVat,
    platformCommissionPercent:
      map.get('platformCommissionPercent') ?? DEFAULTS.platformCommissionPercent,
    splitRideMatchedSurchargePercent:
      map.get('splitRideMatchedSurchargePercent') ?? DEFAULTS.splitRideMatchedSurchargePercent,
    driverPlatformFeePercent:
      map.get('driverPlatformFeePercent') ?? DEFAULTS.driverPlatformFeePercent,
    driverVatPercent: map.get('driverVatPercent') ?? DEFAULTS.driverVatPercent,
    fareRoundingBracket: map.get('fareRoundingBracket') ?? DEFAULTS.fareRoundingBracket,
  };
}

export async function calculateFareBreakdown(params: {
  distanceKm: number;
  departureDate: Date;
  departureTime: string;
  luggageCount: number;
  requestedSeats: number;
  rideType: 'private' | 'split';
  waitingMinutes?: number;
  activeRiderCount?: number;
}): Promise<FareBreakdown> {
  const {
    distanceKm,
    departureDate,
    departureTime,
    luggageCount,
    requestedSeats,
    rideType,
    waitingMinutes = 0,
    activeRiderCount = 1,
  } = params;

  const settings = await loadFareSettings();
  const rates = getDayNightRates(departureTime, settings);

  const totalKmCharge = roundMoney(distanceKm * rates.perKm);
  let regulatedBase = roundMoney(rates.initialCharge + totalKmCharge);

  let waitingCharge = 0;
  if (waitingMinutes > 0) {
    waitingCharge = roundMoney((rates.waitingChargePerHour * waitingMinutes) / 60);
    regulatedBase += waitingCharge;
  }

  let sixPassengerExtraCharge = 0;
  if (requestedSeats === 6) {
    const beforeMultiplier = regulatedBase;
    const multiplier = 1 + settings.sixPassengerExtraChargePercentage / 100;
    regulatedBase = roundMoney(regulatedBase * multiplier);
    sixPassengerExtraCharge = roundMoney(regulatedBase - beforeMultiplier);
  }

  const luggageCharge = roundMoney(luggageCount * settings.perLuggageCharge);
  let subTotal = roundMoney(regulatedBase + luggageCharge);

  let holidaySurcharge = 0;
  const isHoliday = await isPublicHoliday(departureDate);

  if (isHoliday) {
    holidaySurcharge = roundMoney(subTotal * (settings.holidayIncreasePercentage / 100));
    subTotal += holidaySurcharge;
  }

  const fivePassengerExtraCharge = 0;
  const passengerCountExtra = sixPassengerExtraCharge;

  const rawComponentFare = roundMoney(
    regulatedBase + luggageCharge + holidaySurcharge,
  );

  const riderCount = Math.max(Number(activeRiderCount) || 1, 1);
  const fareTotals = buildPassengerFareTotals({
    rideType,
    riderCount,
    rawComponentFare,
    baseFare: settings.baseFare,
    platformVatPercent: settings.platformVat,
    platformCommissionPercent: settings.platformCommissionPercent,
    splitRideMatchedSurchargePercent: settings.splitRideMatchedSurchargePercent,
    fareRoundingBracket: settings.fareRoundingBracket,
  });

  return {
    initialCharge: rates.initialCharge,
    perKmCharge: rates.perKm,
    totalKmCharge,
    luggageCharge,
    passengerCountExtra,
    holidaySurcharge,
    waitingCharge,
    fivePassengerExtraCharge,
    sixPassengerExtraCharge,
    fivePassengerExtraChargePercentage:
      requestedSeats === 5 ? settings.fivePassengerExtraChargePercentage : 0,
    sixPassengerExtraChargePercentage:
      requestedSeats === 6 ? settings.sixPassengerExtraChargePercentage : 0,
    baseFare: settings.baseFare,
    actualFare: fareTotals.actualFare,
    fareBeforeFees: fareTotals.fareBeforeFees,
    bracketRoundedFare: fareTotals.bracketRoundedFare,
    vat: fareTotals.vatAmount,
    vatIncluded: fareTotals.vatIncluded,
    netBeforeVat: fareTotals.netBeforeVat,
    minimumFareApplied: fareTotals.minimumFareApplied,
    minimumFareAmount: settings.baseFare,
    minimumFareAdjustment: fareTotals.minimumFareAdjustment,
    splitSurchargePercent: fareTotals.splitSurchargePercent,
    splitSurchargeAmount: fareTotals.splitSurchargeAmount,
    splitRideMatchedSurchargePercent: fareTotals.splitRideMatchedSurchargePercent,
    splitRideMatchedSurchargeAmount: fareTotals.splitRideMatchedSurchargeAmount,
    fareBeforePlatformCommission: fareTotals.fareBeforePlatformCommission,
    platformVatPercent: fareTotals.platformVatPercent,
    vatAmount: fareTotals.vatAmount,
    platformCommissionPercent: fareTotals.platformCommissionPercent,
    platformCommission: fareTotals.platformCommissionAmount,
    platformCommissionAmount: fareTotals.platformCommissionAmount,
    totalFare: fareTotals.totalFare,
  };
}
