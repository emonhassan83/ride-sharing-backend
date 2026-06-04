// utils/fareCalculator.ts
import { Setting } from '../modules/settings/settings.model';

export interface FareBreakdown {
  initialCharge: number;
  perKmCharge: number;
  totalKmCharge: number;
  luggageCharge: number;
  passengerCountExtra: number;
  holidaySurcharge: number;
  waitingCharge: number;
  extraCharge: number;
  vat: number;
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

// Default fallback values — used if DB fetch fails
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

// TODO: Public holidays (MM-DD)
const PUBLIC_HOLIDAYS = [
  '12-24',
  '12-25',
  '12-26',
  '12-31',
  '01-01',
  '03-29',
  '04-01',
  '05-01',
];

export function isPublicHoliday(date: Date): boolean {
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return PUBLIC_HOLIDAYS.includes(`${month}-${day}`);
}

// ── Load all fare settings from DB in one query ───────────────────────────────
export async function loadFareSettings(): Promise<FareSettings> {
  const keys = Object.keys(DEFAULTS);

  const docs = await Setting.find({ key: { $in: keys } })
    .select('key value')
    .lean();

  const map = new Map(docs.map((d) => [d.key, Number(d.value)]));

  return {
    dayFareInitialCharge:
      map.get('dayFareInitialCharge') ?? DEFAULTS.dayFareInitialCharge,
    dayFarePerKMRate: map.get('dayFarePerKMRate') ?? DEFAULTS.dayFarePerKMRate,
    dayFareWaitingCharge:
      map.get('dayFareWaitingCharge') ?? DEFAULTS.dayFareWaitingCharge,
    nightFareInitialCharge:
      map.get('nightFareInitialCharge') ?? DEFAULTS.nightFareInitialCharge,
    nightFarePerKMRate:
      map.get('nightFarePerKMRate') ?? DEFAULTS.nightFarePerKMRate,
    nightFareWaitingCharge:
      map.get('nightFareWaitingCharge') ?? DEFAULTS.nightFareWaitingCharge,
    perLuggageCharge: map.get('perLuggageCharge') ?? DEFAULTS.perLuggageCharge,
    holidayIncreasePercentage:
      map.get('holidayIncreasePercentage') ??
      DEFAULTS.holidayIncreasePercentage,
    fivePassengerExtraCharge:
      map.get('fivePassengerExtraCharge') ?? DEFAULTS.fivePassengerExtraCharge,
    sixPassengerExtraChargePercentage:
      map.get('sixPassengerExtraChargePercentage') ??
      DEFAULTS.sixPassengerExtraChargePercentage,
    platformVat: map.get('platformVat') ?? DEFAULTS.platformVat,
    platformCommissionPercent:
      map.get('platformCommissionPercent') ??
      DEFAULTS.platformCommissionPercent,
  };
}

function getDayNightRate(
  departureTimeStr: string,
  settings: FareSettings
): DayNightRates {
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

// ── Main calculator — async, loads settings from DB ──────────────────────────
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

  // ── Load settings ─────────────────────────────────────────────────────────
  const settings = await loadFareSettings();
  const rates = getDayNightRate(departureTime, settings);

  // ── 1. Base fare ──────────────────────────────────────────────────────────
  const initialCharge = rates.initialCharge;
  const totalKmCharge = Math.round(distanceKm * rates.perKm * 100) / 100;
  let subTotal = initialCharge + totalKmCharge;

  // ── 2. Luggage charge ─────────────────────────────────────────────────────
  const luggageCharge =
    Math.round(luggageCount * settings.perLuggageCharge * 100) / 100;
  subTotal += luggageCharge;

  // ── 3. Passenger count extra (private ride only) ──────────────────────────
  let passengerCountExtra = 0;
  if (rideType === 'private') {
    if (requestedSeats === 5) {
      passengerCountExtra = settings.fivePassengerExtraCharge;
    } else if (requestedSeats === 6) {
      passengerCountExtra =
        Math.round(
          subTotal * (settings.sixPassengerExtraChargePercentage / 100) * 100
        ) / 100;
    }
    subTotal += passengerCountExtra;
  }

  // ── 4. Holiday surcharge ──────────────────────────────────────────────────
  let holidaySurcharge = 0;
  if (isPublicHoliday(departureDate)) {
    holidaySurcharge =
      Math.round(subTotal * (settings.holidayIncreasePercentage / 100) * 100) /
      100;
    subTotal += holidaySurcharge;
  }

  // ── 5. Waiting charge ─────────────────────────────────────────────────────
  let waitingCharge = 0;
  if (waitingMinutes > 0) {
    waitingCharge =
      Math.round(((rates.waitingChargePerHour * waitingMinutes) / 60) * 100) /
      100;
    subTotal += waitingCharge;
  }

  // ── 6. VAT (included in price — shown for breakdown only) ────────────────
  const vat = Math.round(subTotal * (settings.platformVat / 100) * 100) / 100;
  // VAT is included, so totalFare does NOT add vat on top
  // If your business model adds VAT on top, change to: subTotal += vat
  const totalFare = Math.round(subTotal * 100) / 100;

  return {
    initialCharge,
    perKmCharge: rates.perKm,
    totalKmCharge,
    luggageCharge,
    passengerCountExtra,
    holidaySurcharge,
    waitingCharge,
    extraCharge: 0,
    vat,
    totalFare,
  };
}

// ── Sync version — use only when settings are pre-loaded ─────────────────────
export function calculateFareBreakdownSync(
  params: {
    distanceKm: number;
    departureDate: Date;
    departureTime: string;
    luggageCount: number;
    requestedSeats: number;
    rideType: 'private' | 'split';
    waitingMinutes?: number;
  },
  settings: FareSettings
): FareBreakdown {
  const {
    distanceKm,
    departureDate,
    departureTime,
    luggageCount,
    requestedSeats,
    rideType,
    waitingMinutes = 0,
  } = params;

  const rates = getDayNightRate(departureTime, settings);
  const initialCharge = rates.initialCharge;
  const totalKmCharge = Math.round(distanceKm * rates.perKm * 100) / 100;
  let subTotal = initialCharge + totalKmCharge;

  const luggageCharge =
    Math.round(luggageCount * settings.perLuggageCharge * 100) / 100;
  subTotal += luggageCharge;

  let passengerCountExtra = 0;
  if (rideType === 'private') {
    if (requestedSeats === 5) {
      passengerCountExtra = settings.fivePassengerExtraCharge;
    } else if (requestedSeats === 6) {
      passengerCountExtra =
        Math.round(
          subTotal * (settings.sixPassengerExtraChargePercentage / 100) * 100
        ) / 100;
    }
    subTotal += passengerCountExtra;
  }

  let holidaySurcharge = 0;
  if (isPublicHoliday(departureDate)) {
    holidaySurcharge =
      Math.round(subTotal * (settings.holidayIncreasePercentage / 100) * 100) /
      100;
    subTotal += holidaySurcharge;
  }

  let waitingCharge = 0;
  if (waitingMinutes > 0) {
    waitingCharge =
      Math.round(((rates.waitingChargePerHour * waitingMinutes) / 60) * 100) /
      100;
    subTotal += waitingCharge;
  }

  const vat = Math.round(subTotal * (settings.platformVat / 100) * 100) / 100;
  const totalFare = Math.round(subTotal * 100) / 100;

  return {
    initialCharge,
    perKmCharge: rates.perKm,
    totalKmCharge,
    luggageCharge,
    passengerCountExtra,
    holidaySurcharge,
    waitingCharge,
    extraCharge: 0,
    vat,
    totalFare,
  };
}
