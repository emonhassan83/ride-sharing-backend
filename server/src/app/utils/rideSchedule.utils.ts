import { StatusCodes } from 'http-status-codes';
import ApiError from '../errors/ApiError';
import { Setting } from '../modules/settings/settings.model';

export type RideScheduleType = 'private' | 'split';

export const DEFAULT_SPLIT_MIN_BOOKING_HOURS = 3;
export const DEFAULT_PRIVATE_MIN_BOOKING_HOURS = 1;
export const DEFAULT_SPLIT_MIN_DISTANCE_KM = 20;
export const DEFAULT_SPLIT_REFUND_RESTRICTION_HOURS = 24;
export const DEFAULT_PRIVATE_REFUND_RESTRICTION_HOURS = 1;
export const DEFAULT_MATCHING_LAST_NOTIFY_HOURS = 1;

export const getDepartureDateTime = (
  departureDate: string,
  departureTime: string
): Date => {
  const [year, month, day] = departureDate.split('-').map(Number);
  const [rawHour, minute] = departureTime.split(':').map(Number);

  if (
    !year ||
    !month ||
    !day ||
    Number.isNaN(rawHour) ||
    Number.isNaN(minute)
  ) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Invalid departureDate or departureTime'
    );
  }

  if (rawHour === 24 && minute === 0) {
    const date = new Date(year, month - 1, day, 0, 0);
    date.setDate(date.getDate() + 1);
    return date;
  }

  if (rawHour < 0 || rawHour > 23 || minute < 0 || minute > 59) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Invalid departureDate or departureTime'
    );
  }

  // Client rule: booking time must be 30-minute increments only (:00 or :30).
  if (minute !== 0 && minute !== 30) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Booking time must be in 30-minute increments only (e.g. 18:00 or 18:30).'
    );
  }

  return new Date(year, month - 1, day, rawHour, minute);
};

export const getHoursUntilDeparture = (departureDateTime: Date): number =>
  (departureDateTime.getTime() - Date.now()) / 3600000;

const normalizeRideType = (rideType: string): RideScheduleType =>
  rideType === 'split' ? 'split' : 'private';

const getNumericSetting = async (key: string, fallback: number): Promise<number> => {
  const setting = await Setting.findOne({ key }).lean();
  const value = Number(setting?.value ?? fallback);
  return value > 0 ? value : fallback;
};

export const getMinBookingLeadHours = async (
  rideType: string
): Promise<number> => {
  const normalized = normalizeRideType(rideType);
  if (normalized === 'split') {
    const value = await getNumericSetting(
      'splitRideMinBookingHours',
      DEFAULT_SPLIT_MIN_BOOKING_HOURS,
    );
    // Migrate legacy default (24h) to client-required 3h.
    if (value === 24) {
      await Setting.findOneAndUpdate(
        { key: 'splitRideMinBookingHours' },
        { $set: { value: DEFAULT_SPLIT_MIN_BOOKING_HOURS } },
        { upsert: true },
      );
      return DEFAULT_SPLIT_MIN_BOOKING_HOURS;
    }
    return value;
  }

  return getNumericSetting(
    'privateRideMinBookingHours',
    DEFAULT_PRIVATE_MIN_BOOKING_HOURS,
  );
};

export const getSplitMinDistanceKm = async (): Promise<number> =>
  getNumericSetting('splitRideMinDistanceKm', DEFAULT_SPLIT_MIN_DISTANCE_KM);

export const getMatchingLastNotifyHours = async (): Promise<number> =>
  getNumericSetting('matchingLastNotifyHours', DEFAULT_MATCHING_LAST_NOTIFY_HOURS);

export const assertSplitMinimumDistance = async (
  distanceKm: number
): Promise<number> => {
  const minDistanceKm = await getSplitMinDistanceKm();
  const distance = Number(distanceKm) || 0;

  if (distance < minDistanceKm) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Split ride requires a minimum route distance of ${minDistanceKm} km.`
    );
  }

  return minDistanceKm;
};

export const getRefundRestrictionHours = async (
  rideType: string
): Promise<number> => {
  const normalized = normalizeRideType(rideType);
  return normalized === 'split'
    ? getNumericSetting('splitRideRefundRestrictionHours', DEFAULT_SPLIT_REFUND_RESTRICTION_HOURS)
    : getNumericSetting('privateRideRefundRestrictionHours', DEFAULT_PRIVATE_REFUND_RESTRICTION_HOURS);
};

export const assertMinimumBookingLeadTime = async (
  departureDate: string,
  departureTime: string,
  rideType: string
): Promise<{ departureDateTime: Date; hoursUntilDeparture: number; minLeadHours: number }> => {
  const departureDateTime = getDepartureDateTime(departureDate, departureTime);
  const hoursUntilDeparture = getHoursUntilDeparture(departureDateTime);
  const minLeadHours = await getMinBookingLeadHours(rideType);

  if (hoursUntilDeparture < minLeadHours) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `${normalizeRideType(rideType) === 'split' ? 'Split' : 'Private'} ride must be scheduled at least ${minLeadHours} hour${minLeadHours === 1 ? '' : 's'} before pickup time.`
    );
  }

  return { departureDateTime, hoursUntilDeparture, minLeadHours };
};