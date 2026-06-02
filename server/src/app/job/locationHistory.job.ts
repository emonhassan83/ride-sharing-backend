// jobs/locationHistory.job.ts (optimized)
import cron from 'node-cron';
import { getRedisClient } from '../config/redis.config';
import { Ride } from '../modules/ride/ride.model';
import { LocationHistory } from '../modules/locationHistory/locationHistory.model';
import { Passenger } from '../modules/passenger/passenger.model';
import { calculateDuration, calculateTotalDistance } from '../utils/location.utils';

const BATCH_SIZE = 100; // প্রতি ব্যাচে কত রাইড প্রসেস করব

export async function batchInsertLocationHistory() {
  const redis = getRedisClient();
  let cursor = '0';
  const keysToProcess: string[] = [];

  // ✅ 1. SCAN ব্যবহার করে কী সংগ্রহ করা (keys এর পরিবর্তে)
  do {
    const reply = await redis.scan(cursor, 'MATCH', 'ride:*:live', 'COUNT', BATCH_SIZE);
    cursor = reply[0];
    keysToProcess.push(...reply[1]);
  } while (cursor !== '0');

  if (keysToProcess.length === 0) return;

  // ✅ 2. রাইড আইডি বের করা
  const rideIds = keysToProcess.map(key => key.split(':')[1]);

  // ✅ 3. একসাথে সব রাইডের তথ্য ডাটাবেজ থেকে আনা (একটি কোয়েরি)
  const rides = await Ride.find({ _id: { $in: rideIds } })
    .select('_id driverId status')
    .lean();

  const rideMap = new Map(rides.map(r => [r._id.toString(), r]));

  // ✅ 4. একসাথে সব প্যাসেঞ্জার আইডি সংগ্রহ (প্রয়োজন হলে)
  const passengerMap = new Map<string, string[]>(); // rideId -> userIds[]
  const passengers = await Passenger.find({ rideId: { $in: rideIds } })
    .select('rideId userId')
    .lean();
  for (const p of passengers) {
    const rid = p.rideId.toString();
    if (!passengerMap.has(rid)) passengerMap.set(rid, []);
    passengerMap.get(rid)!.push(p.userId.toString());
  }

  // ✅ 5. প্রতিটি রাইডের জন্য লোকেশন ডাটা প্রসেস ও সেভ (সমান্তরালে)
  const operations = keysToProcess.map(async (key) => {
    const rideId = key.split(':')[1];
    const locationsData = await redis.lrange(key, 0, -1);
    if (locationsData.length === 0) return;

    const ride = rideMap.get(rideId);
    const isTripCompleted = ride?.status === 'completed';
    if (locationsData.length < 10 && !isTripCompleted) return;

    const parsedLocations = locationsData.map(loc => JSON.parse(loc));
    const startTime = new Date(parsedLocations[0].timestamp);
    const endTime = new Date(parsedLocations[parsedLocations.length - 1].timestamp);
    const totalDistance = calculateTotalDistance(parsedLocations);
    const totalDuration = calculateDuration(parsedLocations);
    const avgSpeed = totalDuration > 0 ? (totalDistance / (totalDuration / 3600)) : 0;
    const maxSpeed = Math.max(...parsedLocations.map((l: any) => l.speed || 0), 0);

    const formattedLocations = parsedLocations.map((loc: any) => ({
      lat: loc.lat, lng: loc.lng, speed: loc.speed || 0,
      heading: loc.heading || 0, timestamp: new Date(loc.timestamp),
      event: loc.event || 'WAYPOINT',
    }));

    const passengerIds = passengerMap.get(rideId) || [];

    const existing = await LocationHistory.findOne({ rideId });
    if (!existing) {
      await LocationHistory.create({
        rideId,
        driverId: ride?.driverId,
        passengerIds,
        locations: formattedLocations,
        startTime,
        endTime,
        totalDistance,
        totalDuration,
        averageSpeed: avgSpeed,
        maxSpeed,
      });
    }
    // লোকেশন কী ডিলিট (যাতে পরবর্তী জবে পুনরায় না নেয়)
    await redis.del(key);
  });

  await Promise.all(operations);
  console.log(`✅ Location history saved for ${keysToProcess.length} rides`);
}