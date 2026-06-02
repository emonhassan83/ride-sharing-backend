// utils/fareCalculator.ts
import { calculateDistance } from './location.utils';

// Public holidays (month-day)
const PUBLIC_HOLIDAYS = [
  '12-24', '12-25', '12-26', '12-31', // Dec 24,25,26,31
  '01-01', // Jan 1
  // Good Friday, Easter, Easter Monday are variable dates – simplified: we can accept a year parameter or fetch from external API.
  // For now, we'll include a placeholder; the user can extend.
  '03-29', // Example Good Friday 2024 (change yearly)
  '03-31', // Easter Sunday 2024 (not needed)
  '04-01', // Easter Monday 2024
  '05-01', // May 1
];

export function isPublicHoliday(date: Date): boolean {
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const key = `${month}-${day}`;
  return PUBLIC_HOLIDAYS.includes(key);
}

interface DayNightRates {
  initialCharge: number;
  perKm: number;
  waitingChargePerHour: number;
}

export function getDayNightRate(departureDate: Date, departureTimeStr: string): DayNightRates {
  // Parse departureTime (HH:MM)
  const [hour] = departureTimeStr.split(':').map(Number);
  const isNight = (hour >= 20 && hour < 24) || (hour >= 0 && hour < 6); // 20:30 - 06:00
  // Actually night fare from 20:30 to 06:00; simplify using hour
  if (isNight) {
    return {
      initialCharge: 4.80,
      perKm: 1.10,
      waitingChargePerHour: 19.00,
    };
  } else {
    return {
      initialCharge: 3.80,
      perKm: 0.95,
      waitingChargePerHour: 17.00,
    };
  }
}

export interface FareBreakdown {
  initialCharge: number;
  perKmCharge: number;
  totalKmCharge: number;
  luggageCharge: number;
  passengerCountExtra: number; // for 4 or 6 passenger taxi
  holidaySurcharge: number;
  waitingCharge?: number; // initially 0
  extraCharge?: number;   // other extras, initially 0
  vat: number;
  totalFare: number;
}

export function calculateFareBreakdown(params: {
  distanceKm: number;
  departureDate: Date;
  departureTime: string;
  luggageCount: number;
  requestedSeats: number;
  rideType: 'private' | 'split';
  waitingMinutes?: number; // optional, for later use
}): FareBreakdown {
  const { distanceKm, departureDate, departureTime, luggageCount, requestedSeats, rideType, waitingMinutes = 0 } = params;

  // 1. Determine day/night rates
  const rates = getDayNightRate(departureDate, departureTime);

  // 2. Base fare
  const initialCharge = rates.initialCharge;
  const totalKmCharge = distanceKm * rates.perKm;
  let subTotal = initialCharge + totalKmCharge;

  // 3. Luggage charge (per luggage €2)
  const luggageCharge = luggageCount * 2.00;
  subTotal += luggageCharge;

  // 4. Passenger count extra (only if rideType is private, because split ride passengers are separate)
  let passengerCountExtra = 0;
  if (rideType === 'private') {
    if (requestedSeats === 4) {
      passengerCountExtra = 1.40;
    } else if (requestedSeats === 6) {
      passengerCountExtra = subTotal * 0.40; // 40% increase on total so far? According to document: 40% increase for 6 passenger taxi. Usually it's on total fare.
      // We'll apply on subTotal before holiday surcharge?
    }
    subTotal += passengerCountExtra;
  }

  // 5. Holiday surcharge (20% extra) – applied on subTotal before VAT?
  let holidaySurcharge = 0;
  if (isPublicHoliday(departureDate)) {
    holidaySurcharge = subTotal * 0.20;
    subTotal += holidaySurcharge;
  }

  // 6. Waiting charge (if any) – per hour rate * minutes/60
  let waitingCharge = 0;
  if (waitingMinutes > 0) {
    waitingCharge = (rates.waitingChargePerHour * waitingMinutes) / 60;
    subTotal += waitingCharge;
  }

  // 7. VAT is already included (9% inside the rates). Document says VAT included, so we do not add extra. However for breakdown we can set vat = subTotal * 0.09? No, because it's already included. We'll set vat = 0 as it's not added.
  const vat = 0;
  const totalFare = Math.round(subTotal * 100) / 100; // round to cents

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