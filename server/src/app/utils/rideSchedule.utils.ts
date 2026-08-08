import { StatusCodes } from 'http-status-codes';
import ApiError from '../errors/ApiError';
import { Setting } from '../modules/settings/settings.model';

export const DEFAULT_MIN_BOOKING_LEAD_HOURS = 1;

export const getDepartureDateTime = (
  departureDate: string,
  departureTime: string
): Date => {
  const [year, month, day] = departureDate.split('-').map(Number);
  const [hour, minute] = departureTime.split(':').map(Number);

  if (
    !year ||
    !month ||
    !day ||
    Number.isNaN(hour) ||
    Number.isNaN(minute)
  ) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Invalid departureDate or departureTime'
    );
  }

  return new Date(year, month - 1, day, hour, minute);
};

export const getHoursUntilDeparture = (departureDateTime: Date): number =>
  (departureDateTime.getTime() - Date.now()) / 3600000;

export const getMinBookingLeadHours = async (): Promise<number> => {
  const setting = await Setting.findOne({ key: 'bookingMinDaysAhead' }).lean();
  const value = Number(setting?.value ?? DEFAULT_MIN_BOOKING_LEAD_HOURS);
  return value > 0 ? value : DEFAULT_MIN_BOOKING_LEAD_HOURS;
};

export const assertMinimumBookingLeadTime = async (
  departureDate: string,
  departureTime: string
): Promise<{ departureDateTime: Date; hoursUntilDeparture: number; minLeadHours: number }> => {
  const departureDateTime = getDepartureDateTime(departureDate, departureTime);
  const hoursUntilDeparture = getHoursUntilDeparture(departureDateTime);
  const minLeadHours = await getMinBookingLeadHours();

  if (hoursUntilDeparture < minLeadHours) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Ride must be scheduled at least ${minLeadHours} hour${minLeadHours === 1 ? '' : 's'} before pickup time.`
    );
  }

  return { departureDateTime, hoursUntilDeparture, minLeadHours };
};
