// handlers/driver/driverGoOffline.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { User } from '../../../modules/user/user.model';
import { removeDriverLocation } from '../../../utils/geo.utils';
import { getIO } from '../../socket.init';

export const driverGoOfflineHandler = async (
  driverId: string,
  options: { lat?: number; lng?: number } = {},
): Promise<{ success: boolean; message: string }> => {
  try {
    const redis = getRedisClient();
    const io    = getIO();

    // ── Get last location: options → Redis → DB ───────────────────────────────
    let lastLat = options.lat;
    let lastLng = options.lng;

    if (!lastLat || !lastLng) {
      try {
        const raw = await redis.get(`driver:${driverId}:current`);
        if (raw) {
          const current = JSON.parse(raw);
          lastLat = current.lat;
          lastLng = current.lng;
        }
      } catch { /* ignore */ }
    }

    if (!lastLat || !lastLng) {
      try {
        const user   = await User.findById(driverId).select('location').lean();
        const coords = user?.location?.coordinates;
        if (coords && (coords[0] !== 0 || coords[1] !== 0)) {
          lastLng = coords[0];
          lastLat = coords[1];
        }
      } catch { /* ignore */ }
    }

    // ── Redis cleanup ─────────────────────────────────────────────────────────
    await removeDriverLocation(driverId);
    await Promise.all([
      redis.del(`driver:${driverId}:details`),
      redis.del(`driver:${driverId}:current`),
      redis.del(`driver:${driverId}:reconnecting`),
      redis.del(`driver:${driverId}:activeRide`),
      redis.srem('users:online', driverId),
    ]);

    // ── DB update — save last location + offline status ───────────────────────
    const dbUpdate: any = {
      isOnline:     false,
      lastOnlineAt: new Date(),
    };

    if (lastLat && lastLng) {
      dbUpdate.location = {
        type:        'Point',
        coordinates: [lastLng, lastLat],
      };
    }

    await User.findByIdAndUpdate(driverId, dbUpdate);

    const onlineCount = await redis.scard('users:online');
    io.emit('onlineUser', onlineCount);

    console.log(`🚗 Driver ${driverId} offline | last location: lat=${lastLat}, lng=${lastLng}`);
    return { success: true, message: 'Driver offline successfully' };
  } catch (error) {
    console.error('Error in driverGoOfflineHandler:', error);
    return { success: false, message: 'Failed to go offline' };
  }
};