import { StatusCodes } from 'http-status-codes';
import ApiError from '../errors/ApiError';
import { config } from '../config/env.config';
import { Setting } from '../modules/settings/settings.model';

export type RideScheduleType = 'private' | 'split';

export const DEFAULT_SPLIT_MIN_BOOKING_HOURS = 3;
export const DEFAULT_PRIVATE_MIN_BOOKING_HOURS = 1;
export const DEFAULT_SPLIT_MIN_DISTANCE_KM = 20;
export const DEFAULT_SPLIT_REFUND_RESTRICTION_HOURS = 24;
export const DEFAULT_PRIVATE_REFUND_RESTRICTION_HOURS = 1;
export const DEFAULT_MATCHING_LAST_NOTIFY_HOURS = 1;
/** Dev default: Asia/Dhaka (matches server TZ). Override with RIDE_TIME_ZONE / TIME_ZONE. */
export const DEFAULT_RIDE_TIME_ZONE = 'Asia/Dhaka';

const getRideTimeZone = (): string =>
  process.env.RIDE_TIME_ZONE || config.timeZone || DEFAULT_RIDE_TIME_ZONE;

/**
 * Interpret departureDate (YYYY-MM-DD) + departureTime (HH:mm) as a wall clock
 * in the ride timezone and return the UTC Date.
 */
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

  let y = year;
  let m = month;
  let d = day;
  let hour = rawHour;

  if (rawHour === 24 && minute === 0) {
    const next = new Date(Date.UTC(year, month - 1, day));
    next.setUTCDate(next.getUTCDate() + 1);
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
    hour = 0;
  } else if (rawHour < 0 || rawHour > 23 || minute < 0 || minute > 59) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Invalid departureDate or departureTime'
    );
  }

  const timeZone = getRideTimeZone();
  // Iteratively align UTC instant so that zoned wall-clock matches Y-M-D H:m.
  const targetAsUtcMs = Date.UTC(y, m - 1, d, hour, minute, 0);
  let guess = new Date(targetAsUtcMs);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(guess)
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    const asUtcMs = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second || 0),
    );
    const diff = targetAsUtcMs - asUtcMs;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }

  return guess;
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