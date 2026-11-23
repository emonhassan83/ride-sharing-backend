// utils/contactPrivacy.utils.ts
//
// B-18: a driver who was only *notified* about a ride request could read the
// rider's full phone number and email (GET /passenger/ride/:rideId,
// GET /passenger/:id, GET /ride/:id), and these endpoints had no ownership check
// at all. Contact details are now shown only once the driver has accepted that
// passenger; until then the phone is masked and the email is hidden.
import { StatusCodes } from 'http-status-codes';
import ApiError from '../errors/ApiError';
import { USER_ROLE } from '../modules/user/user.constant';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';

export type TRequester = { userId?: string; role?: string };

/** Passenger statuses in which the assigned driver may contact the rider (and vice versa). */
export const CONTACT_VISIBLE_PASSENGER_STATUSES = new Set<string>([
  PASSENGER_STATUS.confirmed,
  PASSENGER_STATUS.driver_arrived,
  PASSENGER_STATUS.in_progress,
  PASSENGER_STATUS.picked_up,
  PASSENGER_STATUS.dropped_off,
  PASSENGER_STATUS.completed,
]);

const idOf = (v: any): string => String(v?._id ?? v ?? '');

/** "+8801593578965" -> "+880•••••8965" */
export const maskPhone = (phone?: string | null): string | null => {
  if (!phone) return null;
  const raw = String(phone);
  if (raw.length <= 6) return '•'.repeat(raw.length);
  return `${raw.slice(0, 4)}${'•'.repeat(Math.max(raw.length - 8, 3))}${raw.slice(-4)}`;
};

/** Returns a copy of a populated user with phone masked and email removed. */
export const maskUserContact = <T extends Record<string, any> | null | undefined>(user: T): T => {
  if (!user || typeof user !== 'object') return user;
  const copy: Record<string, any> = { ...user };
  if ('phone' in copy) copy.phone = maskPhone(copy.phone);
  if ('email' in copy) copy.email = null;
  copy.contactMasked = true;
  return copy as T;
};

export const isAdmin = (requester?: TRequester) => requester?.role === USER_ROLE.admin;

/**
 * Who may read a ride's details at all: admin, the assigned driver, a driver
 * the request was sent to, or a rider on the ride.
 */
export const assertCanViewRide = (
  requester: TRequester | undefined,
  ride: { driverId?: any; notifiedDriverIds?: any[]; rideCreatedBy?: any },
  riderUserIds: string[],
) => {
  if (!requester || isAdmin(requester)) return;
  const uid = String(requester.userId || '');
  const allowed =
    idOf(ride.driverId) === uid ||
    (ride.notifiedDriverIds || []).some((id: any) => idOf(id) === uid) ||
    idOf(ride.rideCreatedBy) === uid ||
    riderUserIds.includes(uid);
  if (!allowed) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'You do not have access to this ride');
  }
};

/** May `requester` see this passenger's rider contact details? */
export const canSeeRiderContact = (
  requester: TRequester | undefined,
  ride: { driverId?: any },
  passenger: { userId?: any; status?: string },
): boolean => {
  if (!requester || isAdmin(requester)) return true;
  const uid = String(requester.userId || '');
  if (idOf(passenger.userId) === uid) return true; // the rider themself
  return (
    idOf(ride.driverId) === uid &&
    CONTACT_VISIBLE_PASSENGER_STATUSES.has(String(passenger.status || ''))
  );
};

/** May `requester` (a rider) see the assigned driver's contact details? */
export const canSeeDriverContact = (
  requester: TRequester | undefined,
  ride: { driverId?: any },
  passengers: Array<{ userId?: any; status?: string }>,
): boolean => {
  if (!requester || isAdmin(requester)) return true;
  const uid = String(requester.userId || '');
  if (idOf(ride.driverId) === uid) return true; // the driver themself
  return passengers.some(
    (p) =>
      idOf(p.userId) === uid && CONTACT_VISIBLE_PASSENGER_STATUSES.has(String(p.status || '')),
  );
};
