export const BOOKING_STATUS = {
  pending: 'pending',
  accepted: 'accepted',
  running: 'running',
  rejected: 'rejected',
  cancelled: 'cancelled',
  completed: 'completed',
} as const;

export const PAYMENT_STATUS = {
  pending: 'pending',
  paid: 'paid',
  authorized: 'authorized',
  requires_reauthorization: 'requires_reauthorization',
  failed: 'failed',
  refunded: 'refunded',
  cancelled_authorization: 'cancelled_authorization',
} as const;

export type TBookingStatus = keyof typeof BOOKING_STATUS;
export type TPaymentStatus = keyof typeof PAYMENT_STATUS;