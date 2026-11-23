/**
 * One rule for "is this driver available right now", shared by ride dispatch
 * (notifyDrivers.utils) and the rider's nearby-driver map (geo.utils), so the
 * map never shows a driver that dispatch would silently skip (issues 61 / 63).
 *
 * A driver is live when ANY of these holds:
 *  1. `driver:<id>:current` exists (GPS ping in the last 5 minutes), or
 *  2. `driver:<id>:details.lastUpdate` is within FRESH_LOCATION_MS, or
 *  3. the driver has a connected socket right now AND is in `users:online`.
 *
 * Rule 3 is the fix for "no request until I restarted the app": a driver whose
 * app is open but who is parked (no movement, so no location pings) used to age
 * out after 45 minutes even though they were connected and online.
 *
 * Rules 1-2 alone still cover drivers whose app was killed recently, and
 * old/test accounts with only a stale saved location stay excluded (issue 42).
 */

/** Location ping older than this is not "nearby right now" unless the driver is connected. */
export const FRESH_LOCATION_MS = 45 * 60 * 1000;

export type LatLng = { lat: number; lng: number };

export type DriverLiveState = {
  live: boolean;
  /** Last known point when live; null when not live or no usable point is stored. */
  location: LatLng | null;
};

export function isUsablePoint(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/** True when this server process holds a socket in the driver's room. */
export function isDriverSocketConnected(io: any, driverId: string): boolean {
  try {
    const room = io?.sockets?.adapter?.rooms?.get(`driver:${driverId}`);
    return !!room && room.size > 0;
  } catch {
    return false;
  }
}

export async function getDriverLiveState(
  redis: any,
  driverId: string,
  io?: any,
  now: number = Date.now(),
): Promise<DriverLiveState> {
  try {
    const currentRaw = await redis.get(`driver:${driverId}:current`);
    if (currentRaw) {
      const parsed = JSON.parse(currentRaw);
      const lat = Number(parsed?.lat);
      const lng = Number(parsed?.lng);
      if (isUsablePoint(lat, lng)) return { live: true, location: { lat, lng } };
    }
  } catch {
    /* corrupted record: fall through to the hash */
  }

  let point: LatLng | null = null;
  let freshPing = false;
  try {
    const hash = await redis.hgetall(`driver:${driverId}:details`);
    const lat = Number(hash?.lastLat);
    const lng = Number(hash?.lastLng);
    if (isUsablePoint(lat, lng)) point = { lat, lng };
    const updatedAt = Number(hash?.lastUpdate || 0);
    freshPing = updatedAt > 0 && now - updatedAt <= FRESH_LOCATION_MS;
  } catch {
    /* ignore */
  }

  let connectedAndOnline = false;
  if (!freshPing && isDriverSocketConnected(io, driverId)) {
    try {
      connectedAndOnline = (await redis.sismember('users:online', driverId)) === 1;
    } catch {
      /* ignore */
    }
  }

  const live = freshPing || connectedAndOnline;
  return { live, location: live ? point : null };
}
