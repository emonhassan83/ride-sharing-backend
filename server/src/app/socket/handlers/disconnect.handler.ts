// handlers/disconnect.handler.ts
import { getRedisClient } from '../../config/redis.config';
import { getIO } from '../socket.init';
import { TSocket } from '../interface/index.interface';
import { USER_ROLE } from '../../modules/user/user.constant';
import { User } from '../../modules/user/user.model';
import onlineUsers from '../utils/onlineUsers';

const disconnectHandler = async (socket: TSocket) => {
  try {
    const userId   = socket.auth?._id?.toString();
    const role     = socket.auth?.role;
    const driverId = userId;

    if (!userId) return;

    // Ignore stale disconnect if a newer socket already connected for this user
    if (onlineUsers[userId] && onlineUsers[userId].id !== socket.id) {
      return;
    }

    const redis = getRedisClient();
    const io    = getIO();

    // ── 1. Remove from onlineUsers map ────────────────────────────────────────
    delete onlineUsers[userId];

    // ── 2. Role-specific handling ─────────────────────────────────────────────
    if (role === USER_ROLE.provider) {
      // Keep driver's online status (isOnline) intact across app restarts / network blips.
      // Drivers only go offline via explicit `driver:go-offline` or `logout`.
      await User.findByIdAndUpdate(userId, {
        lastOnlineAt: new Date(),
      });

      const activeRideId = await redis.get(`driver:${driverId}:activeRide`);
      if (activeRideId) {
        console.log(`⚠️ Driver ${driverId} disconnected during active ride ${activeRideId}`);
        io.to(`ride:${activeRideId}`).emit('ride:driver-disconnected', {
          rideId:      activeRideId,
          message:     'Driver lost connection. Please wait...',
          reassigning: false,
          timestamp:   Date.now(),
        });
        await redis.setex(`driver:${driverId}:reconnecting`, 30, 'true');
      }
    } else {
      await redis.srem('users:online', userId);
      await User.findByIdAndUpdate(userId, {
        isOnline:     false,
        lastOnlineAt: new Date(),
      });
    }

    // ── 3. Leave all rooms ────────────────────────────────────────────────────
    socket.rooms.forEach((room) => {
      if (room !== socket.id) {
        socket.leave(room);
      }
    });

    console.log(`❌ Disconnected: userId=${userId} role=${role}`);
  } catch (err: any) {
    console.error('disconnectHandler error:', err.message);
  }
};

export default disconnectHandler;
