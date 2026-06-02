export const RIDE_HISTORY_STATUS = {
  refunded: 'refunded',
  cancelled: 'cancelled',
  completed: 'completed',
} as const;

export const RIDE_HISTORY_PAYMENT_STATUS = {
  pending: 'pending',
  paid: 'paid',
  failed: 'failed',
} as const;

export type TRideHistoryStatus = keyof typeof RIDE_HISTORY_STATUS;
export type TRideHistoryPaymentStatus =
  keyof typeof RIDE_HISTORY_PAYMENT_STATUS;
