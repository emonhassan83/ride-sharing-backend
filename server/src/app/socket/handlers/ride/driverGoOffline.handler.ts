// handlers/driver/driverGoOffline.handler.ts
import { getRedisClient } from "../../../config/redis.config";
import { RIDE_STATUS } from "../../../modules/ride/ride.constant";
import { Ride } from "../../../modules/ride/ride.model";
import { User } from "../../../modules/user/user.model";
import { removeDriverLocation } from "../../../utils/geo.utils";
import { getIO } from "../../socket.init";

export const driverGoOfflineHandler = async (
  driverId: string,
  options: { force?: boolean; reason?: string } = {}
): Promise<{ success: boolean; message: string }> => {
  const { reason = 'manual' } = options;

  try {
    const redis = getRedisClient();
    const io = getIO();

    // সক্রিয় রাইড থাকলে হ্যান্ডেল করুন
    const activeRideId = await redis.get(`driver:${driverId}:activeRide`);
    if (activeRideId) {
      io.to(`ride:${activeRideId}`).emit('ride:driver-disconnected', {
        rideId: activeRideId,
        message: 'Driver went offline. Searching for another driver...',
        reassigning: true,
        reason,
      });

      await Ride.findByIdAndUpdate(activeRideId, {
        status: RIDE_STATUS.pending,
        driverId: null,
        reassignmentNeeded: true,
      });

      await redis.zadd('ride:matching:queue', Date.now(), activeRideId);
      await redis.del(`driver:${driverId}:activeRide`);
      await redis.del(`ride:active:${activeRideId}`);
    }

    // ✅ জিওসেট থেকে ড্রাইভার সরান
    await removeDriverLocation(driverId);
    await redis.del(`driver:${driverId}:details`);
    await redis.del(`driver:${driverId}:current`);
    await redis.srem('users:online', driverId);
    await redis.del(`driver:${driverId}:reconnecting`);

    // ডাটাবেস আপডেট
    await User.findByIdAndUpdate(driverId, {
      isOnline: false,
      lastOnlineAt: new Date(),
    });

    const onlineCount = await redis.scard('users:online');
    io.emit('onlineUser', onlineCount);

    console.log(`🚗 Driver ${driverId} offline (reason: ${reason})`);
    return { success: true, message: 'Driver offline successfully' };
  } catch (error) {
    console.error('Error in driverGoOfflineHandler:', error);
    return { success: false, message: 'Failed to force driver offline' };
  }
};