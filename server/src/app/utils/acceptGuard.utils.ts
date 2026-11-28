import { BOOKING_STATUS } from '../modules/booking/booking.constant';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { Types } from 'mongoose';
import { Passenger } from '../modules/passenger/passenger.model';

// Issue 14: a passenger that was cancelled or refunded (rider cancel, no-driver
// job, split pending-match job) must not be revived by a late driver accept.
// The old accept path had no state checks at all, so a refunded rider was
// confirmed, ridden and completed while keeping the wallet refund.
export const ACCEPT_BLOCKED_MESSAGE = 'Booking has been cancelled or refunded and cannot be accepted.';

const CLOSED_PASSENGER_STATUSES: string[] = [
  PASSENGER_STATUS.cancelled,
  PASSENGER_STATUS.rejected,
  PASSENGER_STATUS.completed,
];

const CLOSED_BOOKING_STATUSES: string[] = [
  BOOKING_STATUS.cancelled,
  BOOKING_STATUS.rejected,
  BOOKING_STATUS.completed,
];

const RELEASED_PAYMENT_STATUSES = ['refunded', 'cancelled_authorization'];

export const BOOKING_CLOSED_FOR_PAYMENT_MESSAGE =
  'This booking has been cancelled or refunded and cannot be paid again.';

/** True when a booking may no longer take a (new) payment. */
export const isClosedForPayment = (
  booking: { bookingStatus?: string | null; paymentStatus?: string | null } | null | undefined,
  passenger: { status?: string | null } | null | undefined,
): boolean => {
  if (booking?.bookingStatus && CLOSED_BOOKING_STATUSES.includes(String(booking.bookingStatus))) return true;
  if (booking?.paymentStatus === 'refunded') return true;
  if (passenger?.status && CLOSED_PASSENGER_STATUSES.includes(String(passenger.status))) return true;
  return false;
};

export const getAcceptBlockReason = (
  passenger: { status?: string | null } | null | undefined,
  booking: { bookingStatus?: string | null; paymentStatus?: string | null } | null | undefined,
): string | null => {
  if (passenger?.status && CLOSED_PASSENGER_STATUSES.includes(String(passenger.status))) {
    return ACCEPT_BLOCKED_MESSAGE;
  }
  if (booking?.bookingStatus && CLOSED_BOOKING_STATUSES.includes(String(booking.bookingStatus))) {
    return ACCEPT_BLOCKED_MESSAGE;
  }
  if (booking?.paymentStatus && RELEASED_PAYMENT_STATUSES.includes(String(booking.paymentStatus))) {
    return ACCEPT_BLOCKED_MESSAGE;
  }
  return null;
};

// ── Accept vs. rider-cancel race ──────────────────────────────────────────────
// Driver accept and rider cancel-before-accept both start from a `pending`
// passenger. The accept used to read the passenger, do its work and only then
// `passenger.save()` with `confirmed`, overwriting a `cancelled` written in the
// meantime: a rider whose hold was already released was revived as confirmed.
// Both sides now flip the status atomically from `pending`, so exactly one wins.

const ACCEPTED_PASSENGER_STATUSES: string[] = [
  PASSENGER_STATUS.confirmed,
  PASSENGER_STATUS.driver_arrived,
  PASSENGER_STATUS.in_progress,
  PASSENGER_STATUS.picked_up,
  PASSENGER_STATUS.dropped_off,
  PASSENGER_STATUS.completed,
];

export type TPassengerAcceptClaim =
  | { claimed: true; firstAccept: boolean }
  | { claimed: false; status: string | null };

/**
 * Atomically moves the passenger pending → confirmed. A passenger already
 * accepted (a retry by the driver) counts as claimed, with `firstAccept: false`.
 */
export const claimPassengerForAccept = async (
  passengerId: Types.ObjectId | string,
): Promise<TPassengerAcceptClaim> => {
  const flipped = await Passenger.findOneAndUpdate(
    { _id: passengerId, status: PASSENGER_STATUS.pending },
    { $set: { status: PASSENGER_STATUS.confirmed } },
    { projection: { _id: 1 } },
  ).lean();
  if (flipped) return { claimed: true, firstAccept: true };

  const current = await Passenger.findById(passengerId).select('status').lean();
  const status = current?.status ? String(current.status) : null;
  if (status && ACCEPTED_PASSENGER_STATUSES.includes(status)) {
    return { claimed: true, firstAccept: false };
  }
  return { claimed: false, status };
};

/** Undo claimPassengerForAccept when the accept fails afterwards. */
export const releasePassengerAcceptClaim = async (passengerId: Types.ObjectId | string): Promise<void> => {
  // Only if it is still our `confirmed`: a job may have cancelled it since.
  await Passenger.updateOne(
    { _id: passengerId, status: PASSENGER_STATUS.confirmed },
    { $set: { status: PASSENGER_STATUS.pending } },
  );
};
