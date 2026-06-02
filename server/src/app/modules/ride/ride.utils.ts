// fare.utils.ts
import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { SettingService } from '../settings/settings.service';
import { getRedisClient } from '../../config/redis.config';

// Check if driver is available for new ride
export const isDriverAvailable = async (driverId: string): Promise<boolean> => {
  const redis = getRedisClient();
  
  // Check 1: Is driver online?
  const isOnline = await redis.sismember('drivers:online', driverId);
  if (!isOnline) return false;
  
  // Check 2: Does driver have active ride?
  const activeRide = await redis.get(`driver:${driverId}:activeRide`);
  if (activeRide) return false;
  
  // Check 3: Check driver details status
  const details = await redis.hgetall(`driver:${driverId}:details`);
  if (details?.status !== 'available') return false;
  
  return true;
};

export const FareUtils = {
  calculateFare: async (payload: {
    estimatedDistanceKm: number;
    rideType: 'split' | 'private';
    requestedSeats: number;
    isNightTrip?: boolean;
    waitingMinutes?: number;
    isPublicHoliday?: boolean;
    luggageBackpackCount?: number;
  }) => {
    const {
      estimatedDistanceKm,
      rideType,
      requestedSeats,
      isNightTrip = false,
      waitingMinutes = 0,
      isPublicHoliday = false,
      luggageBackpackCount = 0,
    } = payload;

    if (estimatedDistanceKm <= 0) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'Distance must be greater than 0');
    }

    // Settings থেকে ডাটা নেওয়া
    const settings = await Promise.all([
      SettingService.getSetting('dayFareInitialCharge'),
      SettingService.getSetting('nightFareInitialCharge'),
      SettingService.getSetting('dayFarePerKMRate'),
      SettingService.getSetting('nightFarePerKMRate'),
      SettingService.getSetting('dayFareWaitingCharge'),
      SettingService.getSetting('platformVat'),
      SettingService.getSetting('publicHolidayIncrease'),
      SettingService.getSetting('perLuggageCharge'),
      SettingService.getSetting('commission-rate'),
    ]);

    const [
      dayInitial,
      nightInitial,
      dayPerKM,
      nightPerKM,
      waitingPerMin,
      vatSetting,
      holidayIncrease,
      luggageCharge,
      commissionSetting,
    ] = settings;

    let baseFare = isNightTrip
      ? Number(nightInitial?.value) || 70
      : Number(dayInitial?.value) || 50;

    const perKmRate = isNightTrip
      ? Number(nightPerKM?.value) || 15
      : Number(dayPerKM?.value) || 12;

    baseFare += estimatedDistanceKm * perKmRate;

    // Waiting Charge
    if (waitingMinutes > 0) {
      baseFare += waitingMinutes * (Number(waitingPerMin?.value) || 2);
    }

    // Luggage Charge
    if (luggageBackpackCount > 0) {
      baseFare += luggageBackpackCount * (Number(luggageCharge?.value) || 10);
    }

    // Public Holiday
    if (isPublicHoliday) {
      const increase = Number(holidayIncrease?.value) || 0;
      baseFare += (baseFare * increase) / 100;
    }

    let finalFare = baseFare * requestedSeats;
    let platformFee = 0;
    let userPayable = finalFare;

    // Split Ride Logic
    if (rideType === 'split') {
      platformFee = finalFare * 0.10;
      finalFare += platformFee;
      userPayable = finalFare / 2;
    }

    // VAT
    const vatRate = Number(vatSetting?.value) || 5;
    const vatAmount = (userPayable * vatRate) / 100;
    userPayable += vatAmount;

    const commissionRate = Number(commissionSetting?.value) || 10;
    const adminCommission = (userPayable * commissionRate) / 100;
    const driverEarning = userPayable - adminCommission;

    return {
      baseFare: Math.round(baseFare),
      totalFareBeforeSplit: Math.round(finalFare),
      platformFee: Math.round(platformFee),
      vatAmount: Math.round(vatAmount),
      userPayable: Math.round(userPayable),
      adminCommission: Math.round(adminCommission),
      driverEarning: Math.round(driverEarning),
    };
  },
};