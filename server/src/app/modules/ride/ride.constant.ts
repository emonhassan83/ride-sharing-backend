export const RIDE_TYPE = {
  split: 'split',
  private: 'private',
} as const;

export const RIDE_STATUS = {
  pending: 'pending',
  accepted: 'accepted',
  rejected: 'rejected',
  cancelled: 'cancelled',
  in_progress: 'in_progress',
  completed: 'completed',
  upcoming: 'upcoming',
  searching: 'searching',
  driver_assigned: 'driver_assigned',
  driver_arrived: 'driver_arrived',
  ongoing: 'ongoing',
} as const;

export const CANCELLED_BY = {
  user: 'user',
  driver: 'driver',
  system: 'system',
} as const;

export type TRideType = keyof typeof RIDE_TYPE;
export type TRideStatus = keyof typeof RIDE_STATUS;
export type TCancelledBy = keyof typeof CANCELLED_BY;
