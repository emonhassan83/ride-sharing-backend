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

// A rider in one of these states has boarded: the driver can no longer cancel
// the ride (driver:cancel-ride answers CANNOT_CANCEL_AFTER_PICKUP).
export const DRIVER_CANCEL_BLOCKING_PASSENGER_STATUSES: Array<
    (typeof PASSENGER_STATUS)[keyof typeof PASSENGER_STATUS]
> = [
    PASSENGER_STATUS.picked_up,
    PASSENGER_STATUS.dropped_off,
    PASSENGER_STATUS.completed,
];

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

