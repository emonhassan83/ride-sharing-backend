// utils/fareCalculator.ts
import { Setting } from '../modules/settings/settings.model';
import axios from 'axios';

const SPLIT_RIDE_SURCHARGE_PERCENT = 0;

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

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
  totalFare: number;
}

interface DayNightRates {
  initialCharge: number;
  perKm: number;
  waitingChargePerHour: number;
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
}

// Default fallback values
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
};

// Cache holidays for the year (in-memory cache)
let holidaysCache: { [year: string]: string[] } = {};

/**
 * Fetch Cyprus Public Holidays from Nager.Date API
 */
async function getCyprusPublicHolidays(year: number): Promise<string[]> {
  const cacheKey = year.toString();

  if (holidaysCache[cacheKey]) {
    return holidaysCache[cacheKey];
  }

  try {
    const response = await axios.get(
      `https://date.nager.at/api/v3/PublicHolidays/${year}/CY`
    );

    const holidays = response.data.map((h: any) => h.date); // "2026-01-01"
    holidaysCache[cacheKey] = holidays;

    return holidays;
  } catch (error) {
    console.warn(`Failed to fetch holidays for ${year}, using fallback`);
    return []; // fallback to no holiday if API fails
  }
}

/**
 * Check if date is a public holiday in Cyprus
 */
export async function isPublicHoliday(date: Date): Promise<boolean> {
  const year = date.getFullYear();
  const dateStr = date.toISOString().split('T')[0]; // "2026-01-01"

  const holidays = await getCyprusPublicHolidays(year);
  return holidays.includes(dateStr);
}

// â”€â”€ Load Fare Settings from DB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    fivePassengerExtraChargePercentage: map.get('fivePassengerExtraChargePercentage') ?? DEFAULTS.fivePassengerExtraChargePercentage,
    sixPassengerExtraChargePercentage: map.get('sixPassengerExtraChargePercentage') ?? DEFAULTS.sixPassengerExtraChargePercentage,
    baseFare: map.get('baseFare') ?? DEFAULTS.baseFare,
    platformVat: map.get('platformVat') ?? DEFAULTS.platformVat,
    platformCommissionPercent: map.get('platformCommissionPercent') ?? DEFAULTS.platformCommissionPercent,
    splitRideMatchedSurchargePercent: map.get('splitRideMatchedSurchargePercent') ?? DEFAULTS.splitRideMatchedSurchargePercent,
  };
}

// â”€â”€ Main Fare Calculator (Async) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  const rates = getDayNightRate(departureTime, settings);

  let subTotal = rates.initialCharge + roundMoney(distanceKm * rates.perKm);

  // Luggage
  const luggageCharge = roundMoney(luggageCount * settings.perLuggageCharge);
  subTotal += luggageCharge;

  // Passenger Extra (Private Ride)
  let passengerCountExtra = 0;
  if (rideType === 'private') {
    if (requestedSeats === 5) {
      passengerCountExtra = roundMoney(subTotal * (settings.fivePassengerExtraChargePercentage / 100));
    } else if (requestedSeats === 6) {
      passengerCountExtra = roundMoney(subTotal * (settings.sixPassengerExtraChargePercentage / 100));
    }
    subTotal += passengerCountExtra;
  }

  // ðŸ”¥ Dynamic Holiday Surcharge
  let holidaySurcharge = 0;
  const isHoliday = await isPublicHoliday(departureDate);

  if (isHoliday) {
    holidaySurcharge = roundMoney(subTotal * (settings.holidayIncreasePercentage / 100));
    subTotal += holidaySurcharge;
  }

  // Waiting Charge
  let waitingCharge = 0;
  if (waitingMinutes > 0) {
    waitingCharge = roundMoney((rates.waitingChargePerHour * waitingMinutes) / 60);
    subTotal += waitingCharge;
  }

  const totalKmCharge = roundMoney(distanceKm * rates.perKm);
  const fivePassengerExtraCharge =
    rideType === 'private' && requestedSeats === 5 ? passengerCountExtra : 0;
  const sixPassengerExtraCharge =
    rideType === 'private' && requestedSeats === 6 ? passengerCountExtra : 0;

  const rawComponentFare = roundMoney(
    rates.initialCharge +
      totalKmCharge +
      luggageCharge +
      holidaySurcharge +
      waitingCharge +
      fivePassengerExtraCharge +
      sixPassengerExtraCharge,
  );
  const baseAdjustedFare = Math.max(rawComponentFare, settings.baseFare);
  const riderCount = Math.max(Number(activeRiderCount) || 1, 1);
  const isMatchedSplitRide = rideType === 'split' && riderCount >= 2;
  const splitRideMatchedSurchargePercent =
    rideType === 'split' ? settings.splitRideMatchedSurchargePercent : 0;
  const splitRideMatchedSurchargeAmount = isMatchedSplitRide
    ? roundMoney(baseAdjustedFare * (splitRideMatchedSurchargePercent / 100))
    : 0;
  const splitSurchargePercent = splitRideMatchedSurchargePercent;
  const splitSurchargeAmount = splitRideMatchedSurchargeAmount;
  const actualFare = roundMoney(rawComponentFare + splitRideMatchedSurchargeAmount);
  const fareAfterMinimum = Math.max(actualFare, settings.baseFare);
  const minimumFareAdjustment = roundMoney(fareAfterMinimum - actualFare);
  const fareBeforePlatformCommission = roundMoney(fareAfterMinimum);
  const platformVatPercent = settings.platformVat;
  const vatAmount = roundMoney(fareBeforePlatformCommission * (platformVatPercent / 100));
  const platformCommissionPercent = settings.platformCommissionPercent;
  const platformCommissionAmount = roundMoney(
    fareBeforePlatformCommission * (platformCommissionPercent / 100),
  );
  const totalFare = roundMoney(
    fareBeforePlatformCommission + vatAmount + platformCommissionAmount,
  );
  const vat = vatAmount;
  const fareBeforeFees = fareAfterMinimum;

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
    fivePassengerExtraChargePercentage: requestedSeats === 5 ? settings.fivePassengerExtraChargePercentage : 0,
    sixPassengerExtraChargePercentage: requestedSeats === 6 ? settings.sixPassengerExtraChargePercentage : 0,
    baseFare: settings.baseFare,
    actualFare,
    fareBeforeFees,
    vat,
    minimumFareApplied: minimumFareAdjustment > 0,
    minimumFareAmount: settings.baseFare,
    minimumFareAdjustment,
    splitSurchargePercent,
    splitSurchargeAmount,
    splitRideMatchedSurchargePercent,
    splitRideMatchedSurchargeAmount,
    fareBeforePlatformCommission,
    platformVatPercent,
    vatAmount,
    platformCommissionPercent,
    platformCommission: platformCommissionAmount,
    platformCommissionAmount,
    totalFare,
  };
}

// Helper function
function getDayNightRate(departureTimeStr: string, settings: FareSettings): DayNightRates {
  const [hour] = departureTimeStr.split(':').map(Number);
  const isNight = hour >= 20 || hour < 6;

  return isNight
    ? {
        initialCharge: settings.nightFareInitialCharge,
        perKm: settings.nightFarePerKMRate,
        waitingChargePerHour: settings.nightFareWaitingCharge,
      }
    : {
        initialCharge: settings.dayFareInitialCharge,
        perKm: settings.dayFarePerKMRate,
        waitingChargePerHour: settings.dayFareWaitingCharge,
      };
}














