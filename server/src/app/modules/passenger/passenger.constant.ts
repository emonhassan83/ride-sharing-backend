export const PASSENGER_STATUS = {
    searching: 'searching',
    confirmed: 'confirmed',
    matched: 'matched',
    driver_arrived: 'driver_arrived',
    in_progress: 'in_progress',
    picked_up: 'picked_up',
    rejected: 'rejected',
    completed: 'completed',
    cancelled: 'cancelled',
    dropped_off: 'dropped_off',
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

export type TPassengerStatus = keyof typeof PASSENGER_STATUS;
export type TFareType = keyof typeof FARE_TYPE;
export type TCancelledBy = keyof typeof CANCELLED_BY;