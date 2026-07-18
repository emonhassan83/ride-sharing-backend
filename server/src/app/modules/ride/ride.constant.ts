export const RIDE_TYPE = {
  split: 'split',
  private: 'private',
} as const;

export const RIDE_STATUS = {
  pending: 'pending',
  rejected: 'rejected',
  accepted: 'accepted',
  cancelled: 'cancelled',
  started: 'started',
  completed: 'completed',
} as const;

export const CANCELLED_BY = {
  user: 'user',
  driver: 'driver',
  system: 'system',
} as const;

export type TRideType = keyof typeof RIDE_TYPE;
export type TRideStatus = keyof typeof RIDE_STATUS;
export type TCancelledBy = keyof typeof CANCELLED_BY;
