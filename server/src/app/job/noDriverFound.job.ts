// jobs/noDriverFound.job.ts (Optimized)
import { getRedisClient } from '../config/redis.config';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { Passenger } from '../modules/passenger/passenger.model';
import { CANCELLED_BY, RIDE_STATUS } from '../modules/ride/ride.constant';
import { Ride } from '../modules/ride/ride.model';
import { getIO } from '../socket/socket.init';

const MATCHING_TIMEOUT_MS = 10 * 60000; // 10 minutes
const BATCH_SIZE = 50; // প্রতি ব্যাচে কত রাইড প্রসেস করব

export const checkNoDriverFound = async () => {
  const redis = getRedisClient();
  const now = Date.now();
  const expiryTime = now - MATCHING_TIMEOUT_MS;

  const expiredRideIds = await redis.zrangebyscore(
    'ride:matching:queue',
    0,
    expiryTime,
    'LIMIT',
    0,
    BATCH_SIZE
  );
  if (!expiredRideIds.length) return;

  // একসাথে রাইড আপডেট (বাল্ক)
  await Ride.updateMany(
    { _id: { $in: expiredRideIds }, status: RIDE_STATUS.pending },
    {
      status: RIDE_STATUS.cancelled,
      cancellationReason: 'no_driver_found',
      cancelledBy: CANCELLED_BY.system,
      cancelledAt: new Date(),
    }
  );

  // প্যাসেঞ্জার আপডেট (একসাথে সব রাইডের জন্য)
  await Passenger.updateMany(
    { rideId: { $in: expiredRideIds }, status: PASSENGER_STATUS.pending },
    {
      status: PASSENGER_STATUS.cancelled,
      cancellationReason: 'no_driver_found',
      cancelledBy: CANCELLED_BY.system,
    }
  );

  // নোটিফিকেশন পাঠান (পৃথকভাবে)
  const passengers = await Passenger.find(
    { rideId: { $in: expiredRideIds }, status: PASSENGER_STATUS.cancelled },
    'userId rideId'
  ).lean();
  const io = getIO();
  for (const p of passengers) {
    io.to(`user:${p.userId}`).emit('ride:no-driver-found', {
      rideId: p.rideId,
      message: 'No drivers available nearby. Please try again later.',
      retryAfter: 5,
    });
  }

  // রেডিস ক্লিনআপ
  const multi = redis.multi();
  for (const rideId of expiredRideIds) {
    multi.zrem('ride:matching:queue', rideId);
    multi.del(`ride:request:${rideId}`);
  }
  await multi.exec();

  console.log(`🚫 No driver found: cancelled ${expiredRideIds.length} rides`);
};
