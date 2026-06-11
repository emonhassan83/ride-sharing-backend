// jobs/driverLocationSync.job.ts
import { getRedisClient } from '../config/redis.config';
import { User } from '../modules/user/user.model';

export async function syncDriverLocationsToDb(): Promise<void> {
  const redis  = getRedisClient();
  const online = await redis.smembers('users:online');

  if (!online.length) return;

  const updates = await Promise.all(
    online.map(async (driverId) => {
      try {
        const raw = await redis.get(`driver:${driverId}:current`);
        if (!raw) return null;
        const { lat, lng } = JSON.parse(raw);
        if (!lat || !lng) return null;
        return { driverId, lat, lng };
      } catch {
        return null;
      }
    }),
  );

  const valid = updates.filter(Boolean) as { driverId: string; lat: number; lng: number }[];
  if (!valid.length) return;

  await Promise.all(
    valid.map(({ driverId, lat, lng }) =>
      User.findByIdAndUpdate(driverId, {
        location: { type: 'Point', coordinates: [lng, lat] },
      }).catch((err) =>
        console.error(`Failed to sync location for driver ${driverId}:`, err),
      ),
    ),
  );

  console.log(`✅ Driver location sync: ${valid.length} driver(s) updated`);
}