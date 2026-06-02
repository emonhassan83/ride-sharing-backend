// handlers/driver/driverRejectRide.handler.ts
import { getRedisClient } from "../../../config/redis.config";
import { RIDE_STATUS, RIDE_TYPE, CANCELLED_BY } from "../../../modules/ride/ride.constant";
import { PASSENGER_STATUS } from "../../../modules/passenger/passenger.constant";
import { Ride } from "../../../modules/ride/ride.model";
import { Passenger } from "../../../modules/passenger/passenger.model";
import { TSocket } from "../../interface/socket.interface";
import { getIO } from "../../socket.init";
import eventHandler from "../../utils/eventHandler";

export const driverRejectRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    let { rideId, passengerId, reason, rejectType = 'single' } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId) {
      callback?.({ success: false, message: 'Missing required fields' });
      return;
    }

    try {
      const ride = await Ride.findById(rideId);
      if (!ride || ride.status !== RIDE_STATUS.pending) {
        callback?.({ success: false, message: 'Ride already accepted or cancelled' });
        return;
      }

      const redis = getRedisClient();
      const io = getIO();

      // ===============================
      // কেস ১: প্রাইভেট রাইড – সম্পূর্ণ রাইড রিজেক্ট
      // ===============================
      if (ride.type === RIDE_TYPE.private) {
        const passenger = await Passenger.findOne({ rideId, status: PASSENGER_STATUS.searching });
        if (passenger) {
          io.to(`user:${passenger.userId}`).emit('ride:driver-rejected', {
            rideId,
            passengerId: passenger._id,
            reason: reason || 'Driver is busy',
            searchingAgain: true,
            rideCancelled: false,   // পুরো রাইড বাতিল হয়নি, অন্য ড্রাইভার খুঁজবে
          });
        }
        // ড্রাইভারকে রিজেক্ট লিস্টে যোগ করুন (যাতে আবার এই রাইড না পায়)
        await redis.sadd(`ride:rejected:${rideId}`, driverId);
        await redis.expire(`ride:rejected:${rideId}`, 300);
        return callback?.({ success: true, message: 'Private ride rejected', passengerCount: passenger ? 1 : 0 });
      }

      // ===============================
      // কেস ২: স্প্লিট রাইড – সম্পূর্ণ রাইড রিজেক্ট (সব প্যাসেঞ্জার)
      // ===============================
      if (rejectType === 'all') {
        const passengers = await Passenger.find({ rideId, status: PASSENGER_STATUS.searching });
        if (passengers.length === 0) {
          return callback?.({ success: false, message: 'No pending passengers to reject' });
        }

        for (const passenger of passengers) {
          io.to(`user:${passenger.userId}`).emit('ride:driver-rejected', {
            rideId,
            passengerId: passenger._id,
            reason: reason || 'Driver rejected entire ride',
            searchingAgain: true,
            rideCancelled: true,   // পুরো রাইড বাতিল
          });
          // প্যাসেঞ্জারের স্ট্যাটাস আপডেট
          passenger.status = PASSENGER_STATUS.cancelled;
          passenger.cancellationReason = reason || 'Driver rejected entire ride';
          passenger.cancelledBy = CANCELLED_BY.driver;
          await passenger.save();
        }

        // রাইড স্ট্যাটাস রিজেক্টেড করুন
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.rejected,
          cancellationReason: reason || 'Driver rejected entire ride',
          cancelledBy: CANCELLED_BY.driver,
          cancelledAt: new Date(),
        });

        // রেডিস ক্লিনআপ
        await redis.sadd(`ride:rejected:${rideId}`, driverId);
        await redis.expire(`ride:rejected:${rideId}`, 300);
        await redis.zrem('ride:matching:queue', rideId);
        await redis.del(`ride:request:${rideId}`);

        return callback?.({ success: true, message: 'Whole ride rejected', passengerCount: passengers.length });
      }

      // ===============================
      // কেস ৩: স্প্লিট রাইড – নির্দিষ্ট প্যাসেঞ্জার রিজেক্ট
      // ===============================
      if (rejectType === 'single' && passengerId) {
        const passenger = await Passenger.findOne({ _id: passengerId, rideId, status: PASSENGER_STATUS.searching });
        if (!passenger) {
          return callback?.({ success: false, message: 'Passenger not found or already processed' });
        }

        // শুধু ওই প্যাসেঞ্জারকে নোটিফাই করুন
        io.to(`user:${passenger.userId}`).emit('ride:driver-rejected', {
          rideId,
          passengerId: passenger._id,
          reason: reason || 'Driver rejected your request',
          searchingAgain: true,
          rideCancelled: false,   // পুরো রাইড বাতিল নয়
        });

        // প্যাসেঞ্জারের স্ট্যাটাস আপডেট (যাতে অন্য ড্রাইভার তাকে না পায়)
        passenger.status = PASSENGER_STATUS.rejected;
        passenger.rejectionReason = reason || 'Driver rejected';
        await passenger.save();

        // এই ড্রাইভারকে রিজেক্ট লিস্টে যোগ করুন (যাতে আবার এই রাইডের অফার না পায়)
        await redis.sadd(`ride:rejected:${rideId}`, driverId);
        await redis.expire(`ride:rejected:${rideId}`, 300);

        // ✅ কর্নার কেস: চেক করুন এই রাইডে অন্য কোনো pending প্যাসেঞ্জার আছে কিনা
        const remainingPassengers = await Passenger.countDocuments({
          rideId,
          status: PASSENGER_STATUS.searching,
        });

        if (remainingPassengers === 0) {
          // কোনো প্যাসেঞ্জার অবশিষ্ট নেই → পুরো রাইড ক্যানসেল করুন
          await Ride.findByIdAndUpdate(rideId, {
            status: RIDE_STATUS.cancelled,
            cancellationReason: 'No passengers left after driver rejection',
            cancelledBy: CANCELLED_BY.system,
            cancelledAt: new Date(),
          });
          await redis.zrem('ride:matching:queue', rideId);
          await redis.del(`ride:request:${rideId}`);
          // সব প্যাসেঞ্জার ইতিমধ্যে ক্যানসেল হয়ে গেছে, তাই আর নোটিফিকেশনের দরকার নেই
          console.log(`Ride ${rideId} cancelled because no passengers left after driver rejection`);
        }

        return callback?.({
          success: true,
          message: `Passenger ${passengerId} rejected successfully`,
          passengerId: passenger._id,
          remainingPassengers,
        });
      }

      // যদি ভুল রিকোয়েস্ট আসে
      callback?.({ success: false, message: 'For split ride, passengerId is required for single rejection' });
    } catch (error) {
      console.error('Error in driverRejectRideHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);