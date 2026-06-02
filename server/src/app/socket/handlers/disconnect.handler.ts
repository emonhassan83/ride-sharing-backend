// handlers/disconnect.handler.ts
import { getRedisClient } from '../../config/redis.config';
import { getIO } from '../socket.init';
import eventHandler from '../utils/eventHandler';
import { TSocket } from '../interface/socket.interface';
import { USER_ROLE } from '../../modules/user/user.constant';
import { Ride } from '../../modules/ride/ride.model';
import { RIDE_STATUS } from '../../modules/ride/ride.constant';
import { User } from '../../modules/user/user.model';
import { driverGoOfflineHandler } from './ride/driverGoOffline.handler';

const disconnectHandler = eventHandler<any>(
  async (socket: TSocket, _data?: any, _ack?: any) => {
    try {
      const userId = socket.auth?._id?.toString();
      const role = socket.auth?.role;
      const driverId = userId;

      if (!userId) return;

      // ✅ ১. ডাটাবেসে ইউজারের অনলাইন স্ট্যাটাস আপডেট
      await User.findByIdAndUpdate(userId, {
        isOnline: false,
        lastOnlineAt: new Date(),
      });

      // ২. গ্লোবাল অনলাইন ইউজার অবজেক্ট (ঐচ্ছিক, পুরানো কোডের জন্য)
      const onlineUsers = (global as any).onlineUsers || {};
      delete onlineUsers[userId];

      // ৩. রেডিস ক্লিনআপ
      const redis = getRedisClient();
      const io = getIO();

      // জেনেরিক: ইউজার অনলাইন সেট থেকে রিমুভ
      await redis.srem('users:online', userId);

      // ========== ড্রাইভার স্পেসিফিক ==========
      if (role === USER_ROLE.provider) {
        const activeRideId = await redis.get(`driver:${driverId}:activeRide`);

        if (activeRideId) {
          // 🔄 ড্রাইভার অ্যাকটিভ রাইডে ছিল → রিকানেক্টের সুযোগ
          console.log(`⚠️ Driver ${driverId} disconnected during active ride ${activeRideId}`);

          // প্যাসেঞ্জারদের নোটিফিকেশন
          io.to(`ride:${activeRideId}`).emit('ride:driver-disconnected', {
            rideId: activeRideId,
            message: 'Driver lost connection. Searching for another driver...',
            reassigning: true,
            timestamp: Date.now(),
          });

          // রাইড স্ট্যাটাস পেন্ডিং ও ড্রাইভার রিমুভ
          await Ride.findByIdAndUpdate(activeRideId, {
            status: RIDE_STATUS.pending,
            driverId: null,
            reassignmentNeeded: true,
            driverDisconnectedAt: new Date(),
          });

          // রাইড আবার ম্যাচিং কিউতে
          await redis.zadd('ride:matching:queue', Date.now(), activeRideId);

          // ✅ ক্লিনআপ: ড্রাইভারের অ্যাকটিভ রাইড কী মুছুন, কিন্তু ড্রাইভারকে অনলাইন সেট থেকে রিমুভ করবেন না এখনই
          await redis.del(`driver:${driverId}:activeRide`);
          await redis.del(`ride:active:${activeRideId}`);

          // 🕒 রিকানেক্ট ফ্ল্যাগ সেট করুন (৩০ সেকেন্ড)
          await redis.setex(`driver:${driverId}:reconnecting`, 30, 'true');

          // ⏰ টাইমআউট – ৩০ সেকেন্ড পর ড্রাইভার না এলে সম্পূর্ণ অফলাইন
          setTimeout(async () => {
            const isReconnecting = await redis.get(`driver:${driverId}:reconnecting`);
            if (!isReconnecting) {
              // আর রিকানেক্ট করেনি – পুরোপুরি অফলাইন
              await driverGoOfflineHandler(driverId, {
                force: true,
                reason: 'disconnect_no_reconnect',
              });
              console.log(`🚗 Driver ${driverId} permanently offlined after disconnect`);
            }
          }, 30000);
        } else {
          // 🟢 কোন অ্যাকটিভ রাইড নেই – সাথে সাথে অফলাইন
          await driverGoOfflineHandler(driverId, {
            force: true,
            reason: 'disconnect',
          });
        }
        // ❗ গুরুত্বপূর্ণ: এখানে আর `drivers:online` ইত্যাদি ম্যানুয়ালি ডিলিট করছি না।
        // `driverGoOfflineHandler` ইতিমধ্যেই সব করবে (অথবা টাইমআউটের পরে করবে)।
      }

      // ৪. সব রুম থেকে বেরিয়ে যাওয়া
      const rooms = Array.from(socket.rooms);
      rooms.forEach((room) => {
        if (room !== socket.id) socket.leave(room);
      });

      // ৫. অনলাইন ইউজার কাউন্ট ব্রডকাস্ট
      const onlineCount = await redis.scard('users:online');
      io.emit('onlineUser', onlineCount);

      console.log(`👤 User disconnected: ${userId} (${role || 'user'})`);
    } catch (err: any) {
      console.error('❌ Disconnect handler error:', err.message);
    }
  }
);

export default disconnectHandler;