import { BOOKING_STATUS } from '../modules/booking/booking.constant';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';

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
