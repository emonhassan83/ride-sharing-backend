/**
 * Split Ride matching eligibility (client §§11–12).
 * Phase 1: pickups within radius. Phase 2: destinations within radius.
 * Time window is configurable (default 0 = exact same departureTime — do not invent a window).
 */
import { getRedisClient } from '../config/redis.config';
import { Setting } from '../modules/settings/settings.model';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { Passenger } from '../modules/passenger/passenger.model';
import { PAYMENT_STATUS as BOOKING_PAYMENT_STATUS } from '../modules/booking/booking.constant';
import { Booking } from '../modules/booking/booking.model';
import { calculateDistance } from './location.utils';
import { getDepartureDateTime } from './rideSchedule.utils';
import { getSplitMaxMatchedRiders } from './splitFare.utils';

export const DEFAULT_SPLIT_PICKUP_MATCH_RADIUS_KM = 10;
export const DEFAULT_SPLIT_DESTINATION_MATCH_RADIUS_KM = 10;
/** 0 = exact departureTime match only until product owner sets a window. */
export const DEFAULT_SPLIT_MATCHING_TIME_WINDOW_MINUTES = 0;

export type LatLng = { lat: number; lng: number };

export type SplitMatchCandidate = {
  pickup: LatLng;
  destination: LatLng;
  departureDate: string;
  departureTime: string;
};

const getNumericSetting = async (key: string, fallback: number): Promise<number> => {
  const setting = await Setting.findOne({ key }).lean();
  const value = Number(setting?.value ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const getSplitPickupMatchRadiusKm = async (): Promise<number> =>
  getNumericSetting('splitRidePickupMatchRadiusKm', DEFAULT_SPLIT_PICKUP_MATCH_RADIUS_KM);

export const getSplitDestinationMatchRadiusKm = async (): Promise<number> =>
  getNumericSetting(
    'splitRideDestinationMatchRadiusKm',
    DEFAULT_SPLIT_DESTINATION_MATCH_RADIUS_KM,
  );

export const getSplitMatchingTimeWindowMinutes = async (): Promise<number> =>
  getNumericSetting(
    'splitRideMatchingTimeWindowMinutes',
    DEFAULT_SPLIT_MATCHING_TIME_WINDOW_MINUTES,
  );

export const coordsToLatLng = (coordinates?: number[] | null): LatLng | null => {
  if (!coordinates || coordinates.length < 2) return null;
  return { lat: coordinates[1], lng: coordinates[0] };
};

export const withinKm = (a: LatLng, b: LatLng, radiusKm: number): boolean =>
  calculateDistance(a, b) <= radiusKm + 1e-9;

/** Phase 1 + Phase 2 between two orders. */
export const passesPhase1And2 = (
  a: SplitMatchCandidate,
  b: SplitMatchCandidate,
  pickupRadiusKm: number,
  destinationRadiusKm: number,
): boolean =>
  withinKm(a.pickup, b.pickup, pickupRadiusKm) &&
  withinKm(a.destination, b.destination, destinationRadiusKm);

export const passesTimeWindow = (
  a: SplitMatchCandidate,
  b: SplitMatchCandidate,
  windowMinutes: number,
): boolean => {
  if (a.departureDate !== b.departureDate) return false;

  if (!windowMinutes || windowMinutes <= 0) {
    return a.departureTime === b.departureTime;
  }

  try {
    const aDt = getDepartureDateTime(a.departureDate, a.departureTime).getTime();
    const bDt = getDepartureDateTime(b.departureDate, b.departureTime).getTime();
    return Math.abs(aDt - bDt) <= windowMinutes * 60 * 1000;
  } catch {
    return false;
  }
};

export const isEligibleSplitPair = (
  a: SplitMatchCandidate,
  b: SplitMatchCandidate,
  pickupRadiusKm: number,
  destinationRadiusKm: number,
  windowMinutes: number,
): boolean =>
  passesTimeWindow(a, b, windowMinutes) &&
  passesPhase1And2(a, b, pickupRadiusKm, destinationRadiusKm);

export const passengerToMatchCandidate = (passenger: any): SplitMatchCandidate | null => {
  const pickup = coordsToLatLng(passenger?.pickup?.coordinates);
  const destination = coordsToLatLng(passenger?.destination?.coordinates);
  if (!pickup || !destination || !passenger?.departureDate || !passenger?.departureTime) {
    return null;
  }
  return {
    pickup,
    destination,
    departureDate: passenger.departureDate,
    departureTime: passenger.departureTime,
  };
};

export const requestToMatchCandidate = (data: {
  pickup: LatLng;
  destination: LatLng;
  departureDate: string;
  departureTime: string;
}): SplitMatchCandidate => ({
  pickup: data.pickup,
  destination: data.destination,
  departureDate: data.departureDate,
  departureTime: data.departureTime,
});

const ACTIVE_STATUSES_EXCLUDE = [
  PASSENGER_STATUS.cancelled,
  PASSENGER_STATUS.rejected,
  PASSENGER_STATUS.split_matching,
];

/** Statuses that count as driver-accepted seats on a split ride. */
export const SPLIT_DRIVER_ACCEPTED_STATUSES = [
  PASSENGER_STATUS.confirmed,
  PASSENGER_STATUS.driver_arrived,
  PASSENGER_STATUS.in_progress,
  PASSENGER_STATUS.picked_up,
  PASSENGER_STATUS.dropped_off,
  PASSENGER_STATUS.completed,
] as const;

export const getActiveSplitPassengersOnRide = async (rideId: any) =>
  Passenger.find({
    rideId,
    status: { $nin: ACTIVE_STATUSES_EXCLUDE },
  })
    .select(
      'pickup destination departureDate departureTime requestedSeats userId estimatedDistanceKm status createdAt',
    )
    .sort({ createdAt: 1 })
    .lean();

export const countActiveSplitPassengersOnRide = async (
  rideId: any,
): Promise<number> =>
  Passenger.countDocuments({
    rideId,
    status: { $nin: ACTIVE_STATUSES_EXCLUDE },
  });

export const getUsedSeatsOnRide = async (rideId: any): Promise<number> => {
  const active = await getActiveSplitPassengersOnRide(rideId);
  return active.reduce((sum, p: any) => sum + (p.requestedSeats || 1), 0);
};

/** Redis lock so concurrent joins cannot race past the max-rider cap. */
export const acquireSplitJoinLock = async (
  rideId: string,
  ttlSeconds = 15,
): Promise<boolean> => {
  const result = await getRedisClient().set(
    `split:join:lock:${rideId}`,
    '1',
    'EX',
    ttlSeconds,
    'NX',
  );
  return result === 'OK';
};

export const releaseSplitJoinLock = async (rideId: string): Promise<void> => {
  await getRedisClient().del(`split:join:lock:${rideId}`);
};

/**
 * After a join/attach: if active riders exceed max, cancel/detach this passenger.
 * Returns true when the passenger may stay on the ride.
 */
export const enforceSplitMaxRidersAfterJoin = async (
  rideId: any,
  passengerId: any,
  mode: 'cancel_new' | 'detach_to_matching' = 'cancel_new',
): Promise<{ ok: boolean; maxMatchedRiders: number; activeCount: number }> => {
  const maxMatchedRiders = await getSplitMaxMatchedRiders();
  const activeCount = await countActiveSplitPassengersOnRide(rideId);

  if (activeCount <= maxMatchedRiders) {
    return { ok: true, maxMatchedRiders, activeCount };
  }

  if (mode === 'detach_to_matching') {
    await Passenger.findOneAndUpdate(
      { _id: passengerId, rideId },
      {
        rideId: null,
        status: PASSENGER_STATUS.split_matching,
        matchedVia: undefined,
        matchedAt: undefined,
      },
    );
    await Booking.findOneAndUpdate(
      { passengerId, rideId },
      { rideId: null, driverId: null },
    );
  } else {
    // Unpaid overflow join — remove entirely so it never shows on the ride.
    await Booking.deleteMany({ passengerId, rideId });
    await Passenger.deleteOne({ _id: passengerId, rideId });
  }

  return { ok: false, maxMatchedRiders, activeCount };
};

/**
 * Hard gate for driver accept: at most N riders, earliest by createdAt win slots.
 */
export const assertDriverCanAcceptSplitPassenger = async (
  rideId: any,
  passengerId: any,
): Promise<{ ok: boolean; message?: string }> => {
  const maxMatchedRiders = await getSplitMaxMatchedRiders();

  const alreadyAccepted = await Passenger.countDocuments({
    rideId,
    status: { $in: [...SPLIT_DRIVER_ACCEPTED_STATUSES] },
  });
  if (alreadyAccepted >= maxMatchedRiders) {
    return {
      ok: false,
      message: `Split ride allows a maximum of ${maxMatchedRiders} matched riders. Driver cannot accept more.`,
    };
  }

  const active = await getActiveSplitPassengersOnRide(rideId);
  const allowedIds = active
    .slice(0, maxMatchedRiders)
    .map((p: any) => p._id.toString());

  if (!allowedIds.includes(String(passengerId))) {
    return {
      ok: false,
      message: `Split ride allows a maximum of ${maxMatchedRiders} matched riders. This passenger is outside the cap.`,
    };
  }

  return { ok: true };
};

/**
 * Candidate ride is eligible if request matches time window + Phase1/2
 * against every active rider (or ride pickup/dest when empty).
 */
export const isRequestEligibleForSplitRide = async (
  request: SplitMatchCandidate,
  ride: any,
  opts?: { requirePaidBooking?: boolean; requestedSeats?: number },
): Promise<{ ok: boolean; reason?: string; activePassengers: any[]; usedSeats: number }> => {
  const pickupRadiusKm = await getSplitPickupMatchRadiusKm();
  const destinationRadiusKm = await getSplitDestinationMatchRadiusKm();
  const windowMinutes = await getSplitMatchingTimeWindowMinutes();
  const maxMatchedRiders = await getSplitMaxMatchedRiders();
  const requestedSeats = opts?.requestedSeats ?? 1;

  if ((ride as any).splitFareLocked) {
    return { ok: false, reason: 'fare_locked', activePassengers: [], usedSeats: 0 };
  }

  const activePassengers = await getActiveSplitPassengersOnRide(ride._id);
  if (activePassengers.length >= maxMatchedRiders) {
    return { ok: false, reason: 'max_riders', activePassengers, usedSeats: 0 };
  }

  const usedSeats = activePassengers.reduce(
    (sum, p: any) => sum + (p.requestedSeats || 1),
    0,
  );
  if (ride.totalSeats && usedSeats + requestedSeats > ride.totalSeats) {
    return { ok: false, reason: 'no_seats', activePassengers, usedSeats };
  }

  if (opts?.requirePaidBooking !== false) {
    const hasPaidBooking = await Booking.exists({
      rideId: ride._id,
      paymentStatus: {
        $in: [BOOKING_PAYMENT_STATUS.authorized, BOOKING_PAYMENT_STATUS.paid],
      },
    });
    if (!hasPaidBooking) {
      return { ok: false, reason: 'no_paid_booking', activePassengers, usedSeats };
    }
  }

  const anchors: SplitMatchCandidate[] = [];
  for (const p of activePassengers) {
    const c = passengerToMatchCandidate(p);
    if (c) anchors.push(c);
  }

  if (!anchors.length) {
    const ridePickup = coordsToLatLng(ride?.pickup?.coordinates);
    const rideDest = coordsToLatLng(ride?.destination?.coordinates);
    if (!ridePickup || !rideDest) {
      return { ok: false, reason: 'missing_ride_geo', activePassengers, usedSeats };
    }
    anchors.push({
      pickup: ridePickup,
      destination: rideDest,
      departureDate: ride.departureDate,
      departureTime: ride.departureTime,
    });
  }

  const allMatch = anchors.every((anchor) =>
    isEligibleSplitPair(
      request,
      anchor,
      pickupRadiusKm,
      destinationRadiusKm,
      windowMinutes,
    ),
  );

  if (!allMatch) {
    return { ok: false, reason: 'geo_or_time', activePassengers, usedSeats };
  }

  return { ok: true, activePassengers, usedSeats };
};

export const findEligibleExistingSplitRide = async (
  request: SplitMatchCandidate,
  rides: any[],
  opts?: { requirePaidBooking?: boolean; requestedSeats?: number; userId?: string },
): Promise<{ ride: any; usedSeats: number; activePassengers: any[] } | null> => {
  for (const ride of rides) {
    if (opts?.userId) {
      const alreadyJoined = await Passenger.findOne({
        rideId: ride._id,
        userId: opts.userId,
        status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
      }).lean();
      if (alreadyJoined) continue;
    }

    const result = await isRequestEligibleForSplitRide(request, ride, opts);
    if (result.ok) {
      return {
        ride,
        usedSeats: result.usedSeats,
        activePassengers: result.activePassengers,
      };
    }
  }
  return null;
};
