import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { getRealDistanceAndETA } from './maps.utils';

/**
 * Issue 13 ("driver arrived, app still says 'Driver arriving in 1 min'").
 *
 * `ride:live-update` used to carry ONE ride-level ETA to everyone, even after the
 * driver had arrived, and on a started ride it was measured to the ride's
 * DESTINATION (the app's "start trip" means "driving to the pickup"). Maps
 * durations are floored at 1 minute, so a driver standing at the pickup was
 * always "1 min" away.
 *
 * Each rider now gets their own phase and ETA:
 *   to_pickup       confirmed / in_progress  -> ETA to THIS rider's pickup
 *   arrived         driver_arrived           -> eta 0, distance 0
 *   to_destination  picked_up                -> ETA to THIS rider's drop-off
 */
export type TLivePhase = 'to_pickup' | 'arrived' | 'to_destination';

export type TRiderLiveUpdate = {
  passengerId: string;
  userId: string;
  phase: TLivePhase;
  eta: number;
  distance: number;
};

type TLivePassenger = {
  _id: unknown;
  userId: unknown;
  status: string;
  pickup?: { coordinates?: number[] };
  destination?: { coordinates?: number[] };
};

export const passengerLivePhase = (status: string): TLivePhase => {
  if (status === PASSENGER_STATUS.driver_arrived) return 'arrived';
  if (status === PASSENGER_STATUS.picked_up) return 'to_destination';
  return 'to_pickup';
};

const PHASE_PRIORITY: Record<TLivePhase, number> = {
  to_pickup: 0,
  to_destination: 1,
  arrived: 2,
};

export async function buildRiderLiveUpdates(
  driver: { lat: number; lng: number },
  passengers: TLivePassenger[],
  etaFn: typeof getRealDistanceAndETA = getRealDistanceAndETA,
): Promise<TRiderLiveUpdate[]> {
  // One Maps call per distinct target (a private ride costs the same as before).
  const cache = new Map<string, Promise<{ distanceKm: number; durationMinutes: number }>>();

  const updates = await Promise.all(
    passengers.map(async (p): Promise<TRiderLiveUpdate> => {
      const phase = passengerLivePhase(p.status);
      const base = {
        passengerId: String(p._id),
        userId: String(p.userId),
        phase,
      };
      if (phase === 'arrived') return { ...base, eta: 0, distance: 0 };

      const coords =
        phase === 'to_pickup' ? p.pickup?.coordinates : p.destination?.coordinates;
      if (!coords || coords.length < 2) return { ...base, eta: 0, distance: 0 };

      const target = { lat: coords[1], lng: coords[0] };
      const key = `${target.lat},${target.lng}`;
      if (!cache.has(key)) cache.set(key, etaFn(driver, target));
      try {
        const { distanceKm, durationMinutes } = await cache.get(key)!;
        return { ...base, eta: durationMinutes, distance: distanceKm };
      } catch {
        return { ...base, eta: 0, distance: 0 };
      }
    }),
  );
  return updates;
}

/** The update shown to non-riders in the ride room (driver app, admin): the next stop. */
export const pickLeadUpdate = (updates: TRiderLiveUpdate[]): TRiderLiveUpdate | null =>
  [...updates].sort(
    (a, b) => PHASE_PRIORITY[a.phase] - PHASE_PRIORITY[b.phase] || a.eta - b.eta,
  )[0] || null;
