// jobs/locationHistory.job.ts
import cron from 'node-cron';
import { getRedisClient } from '../config/redis.config';
import { Ride } from '../modules/ride/ride.model';
import { LocationHistory } from '../modules/locationHistory/locationHistory.model';
import { Passenger } from '../modules/passenger/passenger.model';
import { calculateDuration, calculateTotalDistance } from '../utils/location.utils';

const BATCH_SIZE   = 100;
const VALID_EVENTS = ['TRIP_STARTED', 'ARRIVED_AT_PICKUP', 'WAYPOINT'] as const;

export async function batchInsertLocationHistory() {
  const redis = getRedisClient();
  let cursor = '0';
  const keysToProcess: string[] = [];

  do {
    const reply = await redis.scan(cursor, 'MATCH', 'ride:*:live', 'COUNT', BATCH_SIZE);
    cursor = reply[0];
    keysToProcess.push(...reply[1]);
  } while (cursor !== '0');

  if (keysToProcess.length === 0) return;

  const rideIds = keysToProcess.map(key => key.split(':')[1]);

  const [rides, passengers] = await Promise.all([
    Ride.find({ _id: { $in: rideIds } }).select('_id driverId status').lean(),
    Passenger.find({ rideId: { $in: rideIds } }).select('rideId userId').lean(),
  ]);

  const rideMap = new Map(rides.map(r => [r._id.toString(), r]));

  const passengerMap = new Map<string, string[]>();
  for (const p of passengers) {
    if (!p.rideId) continue;
    const rid = p.rideId.toString();
    if (!passengerMap.has(rid)) passengerMap.set(rid, []);
    passengerMap.get(rid)!.push(p.userId.toString());
  }

  const operations = keysToProcess.map(async (key) => {
    const rideId = key.split(':')[1];

    const locationsData = await redis.lrange(key, 0, -1);
    if (!locationsData.length) return;

    const ride            = rideMap.get(rideId);
    const isTripCompleted = ride?.status === 'completed';
    if (locationsData.length < 10 && !isTripCompleted) return;

    // ── Parse all entries ───────────────────────────────────────────────────
    const allParsed: any[] = locationsData.map(loc => {
      try { return JSON.parse(loc); } catch { return null; }
    }).filter(Boolean);

    // ── Filter: only entries with valid lat/lng (actual location points) ────
    const locationPoints = allParsed.filter(
      (loc) =>
        typeof loc.lat === 'number' &&
        typeof loc.lng === 'number' &&
        !isNaN(loc.lat) &&
        !isNaN(loc.lng),
    );

    if (locationPoints.length < 2) {
      console.log(`⚠️ Not enough valid location points for ride ${rideId} (${locationPoints.length})`);
      return;
    }

    // ── Calculate stats from location points only ───────────────────────────
    const totalDistance = calculateTotalDistance(locationPoints);
    const totalDuration = calculateDuration(locationPoints);

    // Guard against NaN
    if (isNaN(totalDistance) || isNaN(totalDuration)) {
      console.warn(`⚠️ NaN detected for ride ${rideId} — skipping`);
      return;
    }

    const avgSpeed = totalDuration > 0
      ? totalDistance / (totalDuration / 3600)
      : 0;
    const maxSpeed = Math.max(...locationPoints.map((l) => l.speed || 0), 0);

    const startTime = new Date(locationPoints[0].timestamp);
    const endTime   = new Date(locationPoints[locationPoints.length - 1].timestamp);

    // ── Format locations with valid enum ────────────────────────────────────
    const formattedLocations = locationPoints.map((loc) => ({
      lat:       loc.lat,
      lng:       loc.lng,
      speed:     loc.speed   || 0,
      heading:   loc.heading || 0,
      timestamp: new Date(loc.timestamp),
      event:     VALID_EVENTS.includes(loc.event) ? loc.event : 'WAYPOINT',
    }));

    const passengerIds = passengerMap.get(rideId) || [];

    // ── Skip if already exists ──────────────────────────────────────────────
    const existing = await LocationHistory.findOne({ rideId });
    if (existing) {
      await redis.del(key);
      return;
    }

    await LocationHistory.create({
      rideId,
      driverId:     ride?.driverId,
      passengerIds,
      locations:    formattedLocations,
      startTime,
      endTime,
      totalDistance: Math.round(totalDistance * 1000) / 1000,
      totalDuration: Math.round(totalDuration),
      averageSpeed:  Math.round(avgSpeed * 100) / 100,
      maxSpeed:      Math.round(maxSpeed * 100) / 100,
    });

    await redis.del(key);

    console.log(`✅ LocationHistory saved: ride=${rideId} | points=${locationPoints.length} | dist=${totalDistance.toFixed(2)}km`);
  });

  await Promise.all(operations);
  console.log(`✅ Location history batch done: ${keysToProcess.length} ride(s) processed`);
}
