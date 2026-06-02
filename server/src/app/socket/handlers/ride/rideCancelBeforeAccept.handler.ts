// handlers/ride/rideCancelBeforeAccept.handler.ts (সঠিক সংস্করণ)
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, CANCELLED_BY, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

/**
 * Rider cancels ride BEFORE any driver accepts
 * - কোন বুকিং তৈরি হয়নি, তাই বুকিং ক্যানসেলের কোনো প্রয়োজন নেই।
 * - No refund, no fee
 * 
 * কেস ১: স্প্লিট রাইড
 *   - যদি রাইডে এই প্যাসেঞ্জার একাই থাকে → পুরো রাইড ক্যানসেল
 *   - যদি অন্য প্যাসেঞ্জারও থাকে → শুধু এই প্যাসেঞ্জার ক্যানসেল, রাইড চলমান থাকবে
 * 
 * কেস ২: প্রাইভেট রাইড
 *   - পুরো রাইড ক্যানসেল (কারণ প্রাইভেট রাইডে একজন ছাড়া আর কেউ থাকে না)
 */
export const rideCancelBeforeAcceptHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, reason } = data;
    const userId = socket.auth?._id?.toString();

    if (!rideId || !userId) {
      callback?.({ success: false, message: 'Missing required fields' });
      return;
    }

    try {
      const ride = await Ride.findById(rideId);
      if (!ride) {
        callback?.({ success: false, message: 'Ride not found' });
        return;
      }

      // শুধু pending স্টেটে ক্যানসেল করা যাবে
      if (ride.status !== RIDE_STATUS.pending) {
        callback?.({ success: false, message: 'Cannot cancel now: driver already accepted or ride started' });
        return;
      }

      const passenger = await Passenger.findOne({ rideId, userId });
      if (!passenger) {
        callback?.({ success: false, message: 'You are not a passenger in this ride' });
        return;
      }

      if (passenger.status !== PASSENGER_STATUS.searching) {
        callback?.({ success: false, message: 'Already cancelled or confirmed' });
        return;
      }

      const redis = getRedisClient();
      const io = getIO();

      // === প্রাইভেট রাইড: পুরো রাইড ক্যানসেল ===
      if (ride.type === RIDE_TYPE.private) {
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: reason || 'Cancelled by rider (before acceptance)',
          cancelledAt: new Date()
        });

        passenger.status = PASSENGER_STATUS.cancelled;
        passenger.cancellationReason = reason || 'Cancelled by rider';
        passenger.cancelledBy = CANCELLED_BY.user;
        await passenger.save();

        // Redis ক্লিনআপ
        await redis.zrem('ride:matching:queue', rideId);
        await redis.del(`ride:request:${rideId}`);

        io.to(`user:${userId}`).emit('ride:cancelled', {
          rideId,
          message: 'Private ride cancelled successfully',
          refundAmount: 0,
        });

        return callback?.({ success: true, message: 'Private ride cancelled successfully', refundAmount: 0 });
      }

      // === স্প্লিট রাইড ===
      const otherPassengers = await Passenger.countDocuments({
        rideId,
        _id: { $ne: passenger._id },
        status: { $ne: PASSENGER_STATUS.cancelled },
      });

      const hasOtherPassengers = otherPassengers > 0;

      if (!hasOtherPassengers) {
        // এই প্যাসেঞ্জার একাই → পুরো রাইড ক্যানসেল
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: reason || 'Cancelled by rider (no other passengers)',
          cancelledBy: CANCELLED_BY.user,
          cancelledAt: new Date(),
        });

        passenger.status = PASSENGER_STATUS.cancelled;
        passenger.cancellationReason = reason || 'Cancelled by rider';
        passenger.cancelledBy = CANCELLED_BY.user;
        await passenger.save();

        await redis.zrem('ride:matching:queue', rideId);
        await redis.del(`ride:request:${rideId}`);

        io.to(`user:${userId}`).emit('ride:cancelled', {
          rideId,
          message: 'Ride cancelled successfully (you were the only passenger)',
          refundAmount: 0,
        });
      } else {
        // অন্য প্যাসেঞ্জার আছে → শুধু এই প্যাসেঞ্জার ক্যানসেল
        passenger.status = PASSENGER_STATUS.cancelled;
        passenger.cancellationReason = reason || 'Cancelled by rider';
        passenger.cancelledBy = CANCELLED_BY.user;
        await passenger.save();

        // রাইডের bookedSeats কমিয়ে দিন
        await Ride.findByIdAndUpdate(rideId, {
          $inc: { bookedSeats: -passenger.requestedSeats },
        });

        // Redis থেকে শুধু এই প্যাসেঞ্জারের রিকোয়েস্ট ডাটা মুছুন (যদি আলাদা করে সংরক্ষিত থাকে)
        // অথবা সম্পূর্ণ ride:request কী রেখে দিন (যেহেতু অন্য প্যাসেঞ্জার আছে)
        // আমরা ধরে নিচ্ছি ride:request কী পুরো রাইডের জন্য; তাই মুছবেন না।

        io.to(`user:${userId}`).emit('ride:passenger-cancelled', {
          rideId,
          message: 'You have been removed from the ride. Other passengers are still booked.',
        });

        // অন্যান্য প্যাসেঞ্জারদের জানান
        const otherPassengerList = await Passenger.find({
          rideId,
          _id: { $ne: passenger._id },
          status: { $ne: PASSENGER_STATUS.cancelled },
        }).select('userId');

        for (const p of otherPassengerList) {
          io.to(`user:${p.userId}`).emit('ride:co-passenger-cancelled', {
            rideId,
            cancelledPassengerId: passenger._id,
            remainingSeats: ride.totalSeats - (ride.bookedSeats - passenger.requestedSeats),
          });
        }
      }

      callback?.({ success: true, message: 'Cancelled successfully', refundAmount: 0 });
    } catch (error) {
      console.error('Error in rideCancelBeforeAcceptHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);