// handlers/disconnect.handler.ts
import { getRedisClient } from '../../config/redis.config';
import { getIO } from '../socket.init';
import { TSocket } from '../interface/index.interface';
import { USER_ROLE } from '../../modules/user/user.constant';
import { User } from '../../modules/user/user.model';
import { driverGoOfflineHandler } from './ride/driverGoOffline.handler';
import onlineUsers from '../utils/onlineUsers';

const disconnectHandler = async (socket: TSocket) => {
  try {
    const userId   = socket.auth?._id?.toString();
    const role     = socket.auth?.role;
    const driverId = userId;

    if (!userId) return;

    const redis = getRedisClient();
    const io    = getIO();

    // ── 1. Remove from onlineUsers ────────────────────────────────────────────
    delete onlineUsers[userId];

    // ── 2. Remove from users:online set ──────────────────────────────────────
    await redis.srem('users:online', userId);

    // ── 3. Update DB online status ────────────────────────────────────────────
    await User.findByIdAndUpdate(userId, {
      isOnline:     false,
      lastOnlineAt: new Date(),
    });

    // ── 4. Driver specific handling ───────────────────────────────────────────
    if (role === USER_ROLE.provider) {
      const activeRideId = await redis.get(`driver:${driverId}:activeRide`);

      if (activeRideId) {
        // Active ride — give 30s to reconnect
        console.log(`⚠️ Driver ${driverId} disconnected during active ride ${activeRideId}`);

        io.to(`ride:${activeRideId}`).emit('ride:driver-disconnected', {
          rideId:      activeRideId,
          message:     'Driver lost connection. Please wait...',
          reassigning: false,
          timestamp:   Date.now(),
        });

        // Set reconnect flag for 30s
        await redis.setex(`driver:${driverId}:reconnecting`, 30, 'true');

        // After 30s — if not reconnected, go offline
        setTimeout(async () => {
          const isReconnecting = await redis.get(`driver:${driverId}:reconnecting`);
          if (!isReconnecting) {
            await driverGoOfflineHandler(driverId); // lat/lng from Redis/DB auto
            console.log(`🚗 Driver ${driverId} permanently offlined after disconnect`);
          }
        }, 30000);
      } else {
        // No active ride — go offline immediately with last known location
        await driverGoOfflineHandler(driverId); // lat/lng from Redis/DB auto
      }
    }

    // ── 5. Leave all rooms ────────────────────────────────────────────────────
    Array.from(socket.rooms).forEach((room) => {
      if (room !== socket.id) socket.leave(room);
    });

    // ── 6. Broadcast online count ─────────────────────────────────────────────
    const onlineCount = await redis.scard('users:online');
    io.emit('onlineUser', onlineCount);

    console.log(`👤 User disconnected: ${userId} (${role || 'user'})`);
  } catch (err: any) {
    console.error('❌ Disconnect handler error:', err.message);
  }
};

export default disconnectHandler;