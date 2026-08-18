export const PASSENGER_STATUS = {
    pending: 'pending',
    split_matching: 'split_matching',
    rejected: 'rejected',
    confirmed: 'confirmed',
    driver_arrived: 'driver_arrived',
    in_progress: 'in_progress',
    cancelled: 'cancelled',
    picked_up: 'picked_up',
    dropped_off: 'dropped_off',
    completed: 'completed',
} as const;

export const PAYMENT_STATUS = {
    pending: 'pending',
    paid: 'paid',
    authorized: 'authorized',
    requires_reauthorization: 'requires_reauthorization',
    failed: 'failed',
    cancelled_authorization: 'cancelled_authorization',
    pending_recovery: 'pending_recovery'
} as const;

export const FARE_TYPE = {
  day: 'day',
  night: 'night'
} as const;

export const CANCELLED_BY = {
  user: 'user',
  driver: 'driver',
  system: 'system'
} as const;

export type TPaymentStatus = keyof typeof PAYMENT_STATUS;
export type TPassengerStatus = keyof typeof PASSENGER_STATUS;
export type TFareType = keyof typeof FARE_TYPE;
export type TCancelledBy = keyof typeof CANCELLED_BY;

