// utils/fareCalculator.ts
import { Setting } from '../modules/settings/settings.model';
import axios from 'axios';

const PREORDER_MINIMUM_FARE = 20;
const SPLIT_RIDE_SURCHARGE_PERCENT = 15;

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
  sixPassengerExtraChargePercentage: number;
  vat: number;
  minimumFareApplied: boolean;
  minimumFareAmount: number;
  minimumFareAdjustment: number;
  splitSurchargePercent: number;
  splitSurchargeAmount: number;
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
  fivePassengerExtraCharge: number;
  sixPassengerExtraChargePercentage: number;
  platformVat: number;
  platformCommissionPercent: number;
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
  fivePassengerExtraCharge: 1.4,
  sixPassengerExtraChargePercentage: 40,
  platformVat: 9,
  platformCommissionPercent: 10,
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

// ── Load Fare Settings from DB ─────────────────────────────────────
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
    fivePassengerExtraCharge: map.get('fivePassengerExtraCharge') ?? DEFAULTS.fivePassengerExtraCharge,
    sixPassengerExtraChargePercentage: map.get('sixPassengerExtraChargePercentage') ?? DEFAULTS.sixPassengerExtraChargePercentage,
    platformVat: map.get('platformVat') ?? DEFAULTS.platformVat,
    platformCommissionPercent: map.get('platformCommissionPercent') ?? DEFAULTS.platformCommissionPercent,
  };
}

// ── Main Fare Calculator (Async) ───────────────────────────────────
export async function calculateFareBreakdown(params: {
  distanceKm: number;
  departureDate: Date;
  departureTime: string;
  luggageCount: number;
  requestedSeats: number;
  rideType: 'private' | 'split';
  waitingMinutes?: number;
}): Promise<FareBreakdown> {
  const {
    distanceKm,
    departureDate,
    departureTime,
    luggageCount,
    requestedSeats,
    rideType,
    waitingMinutes = 0,
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
      passengerCountExtra = settings.fivePassengerExtraCharge;
    } else if (requestedSeats === 6) {
      passengerCountExtra = roundMoney(subTotal * (settings.sixPassengerExtraChargePercentage / 100));
    }
    subTotal += passengerCountExtra;
  }

  // 🔥 Dynamic Holiday Surcharge
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

  const normalFare = roundMoney(subTotal);
  const fareAfterMinimum = Math.max(normalFare, PREORDER_MINIMUM_FARE);
  const minimumFareAdjustment = roundMoney(fareAfterMinimum - normalFare);
  const splitSurchargePercent = rideType === 'split' ? SPLIT_RIDE_SURCHARGE_PERCENT : 0;
  const splitSurchargeAmount = roundMoney(fareAfterMinimum * (splitSurchargePercent / 100));
  const totalFare = roundMoney(fareAfterMinimum + splitSurchargeAmount);
  const vat = roundMoney(totalFare * (settings.platformVat / 100));

  return {
    initialCharge: rates.initialCharge,
    perKmCharge: rates.perKm,
    totalKmCharge: roundMoney(distanceKm * rates.perKm),
    luggageCharge,
    passengerCountExtra,
    holidaySurcharge,
    waitingCharge,
    fivePassengerExtraCharge: passengerCountExtra,
    sixPassengerExtraChargePercentage: 0,
    vat,
    minimumFareApplied: minimumFareAdjustment > 0,
    minimumFareAmount: PREORDER_MINIMUM_FARE,
    minimumFareAdjustment,
    splitSurchargePercent,
    splitSurchargeAmount,
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

