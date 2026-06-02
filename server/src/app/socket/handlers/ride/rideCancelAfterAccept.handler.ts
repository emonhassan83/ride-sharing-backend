// handlers/ride/rideCancelAfterAccept.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, CANCELLED_BY, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { Refund } from '../../../modules/refund/refund.model';
import { REFUND_STATUS } from '../../../modules/refund/refund.constant';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

function getDepartureDateTime(dateStr: string, timeStr: string): Date {
  // UTC ধরে নিচ্ছি (যাতে সময় অঞ্চলজনিত সমস্যা না হয়)
  const isoString = `${dateStr}T${timeStr}:00Z`;
  return new Date(isoString);
}

function calculateRefundAmount(departureDateTime: Date, cancelTime: Date, paidAmount: number): number {
  const hoursDiff = (departureDateTime.getTime() - cancelTime.getTime()) / (1000 * 60 * 60);
  if (hoursDiff >= 24) return paidAmount;
  if (hoursDiff >= 5) return paidAmount * 0.5;
  return 0;
}

export const rideCancelAfterAcceptHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, reason } = data;
    const userId = socket.auth?._id?.toString();

    if (!rideId || !userId) {
      return callback?.({ success: false, message: 'Missing required fields' });
    }

    try {
      const ride = await Ride.findById(rideId);
      if (!ride) {
        return callback?.({ success: false, message: 'Ride not found' });
      }

      // শুধুমাত্র accepted স্টেটে ক্যানসেল করা যাবে
      if (ride.status !== RIDE_STATUS.accepted) {
        return callback?.({ success: false, message: 'Cannot cancel now: trip already in progress or completed' });
      }

      const passenger = await Passenger.findOne({ rideId, userId });
      if (!passenger) {
        return callback?.({ success: false, message: 'You are not a passenger in this ride' });
      }

      // ✅ সঠিক স্ট্যাটাস চেক (ড্রাইভার একসেপ্টের পর passenger.status = 'matched')
      if (passenger.status !== PASSENGER_STATUS.matched) {
        return callback?.({ success: false, message: 'Already cancelled or not yet accepted' });
      }

      const booking = await Booking.findOne({ passengerId: passenger._id });
      if (!booking) {
        return callback?.({ success: false, message: 'Booking not found' });
      }

      const redis = getRedisClient();
      const io = getIO();

      // রিফান্ড ক্যালকুলেশন (paidAmount বর্তমানে ০, ভবিষ্যতে পেমেন্ট এলে কাজ করবে)
      const paidAmount = booking.amountPaid;
      const cancelTime = new Date();
      const departureDateTime = getDepartureDateTime(ride.departureDate, ride.departureTime);
      const refundAmount = calculateRefundAmount(departureDateTime, cancelTime, paidAmount);

      // ১. প্যাসেঞ্জার ও বুকিং ক্যানসেল
      passenger.status = PASSENGER_STATUS.cancelled;
      passenger.cancellationReason = reason || 'Cancelled by rider after acceptance';
      passenger.cancelledBy = CANCELLED_BY.user;
      await passenger.save();

      booking.bookingStatus = BOOKING_STATUS.cancelled;
      booking.refundAmount = refundAmount;
      await booking.save();

      // ২. রিফান্ড রেকর্ড তৈরি (যদি কোনো টাকা ফেরত দেয়ার থাকে)
      if (refundAmount > 0) {
        await Refund.create({
          user: userId,
          order: booking._id,
          paymentIntentId: booking.transactionId,
          amount: refundAmount,
          reason: `Cancellation: ${reason || 'Rider cancelled after driver accepted'}`,
          note: `Ride ${rideId} cancelled by rider. Departure: ${ride.departureDate} ${ride.departureTime}`,
          status: REFUND_STATUS.pending,
        });
      }

      // ৩. রাইডের বুকড সিট কমানো
      await Ride.findByIdAndUpdate(rideId, {
        $inc: { bookedSeats: -passenger.requestedSeats }
      });

      // ৪. ড্রাইভারের Redis-এ bookedSeats কমানো (যদি ড্রাইভার থাকে)
      if (ride.driverId) {
        await redis.hincrby(`driver:${ride.driverId}:details`, 'bookedSeats', -passenger.requestedSeats);
      }

      // ========== প্রাইভেট রাইড ==========
      if (ride.type === RIDE_TYPE.private) {
        // পুরো রাইড ক্যানসেল
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: reason || 'Private ride cancelled by rider after acceptance',
          cancelledBy: CANCELLED_BY.user,
          cancelledAt: new Date(),
        });

        // ড্রাইভারকে নোটিফাই
        io.to(`driver:${ride.driverId}`).emit('ride:cancelled-by-rider', {
          rideId,
          passengerId: passenger._id,
          reason: reason || 'Rider cancelled the ride',
          refundAmount,
          message: 'Ride has been cancelled by the rider',
        });

        // রেডিস ক্লিনআপ
        await redis.del(`ride:active:${rideId}`);
        await redis.zrem('ride:matching:queue', rideId);
        await redis.del(`ride:request:${rideId}`);

        return callback?.({
          success: true,
          message: refundAmount > 0
            ? `Private ride cancelled. Refund of ${refundAmount} will be processed.`
            : 'Private ride cancelled.',
          refundAmount,
          rideCancelled: true,
        });
      }

      // ========== স্প্লিট রাইড ==========
      const otherPassengers = await Passenger.countDocuments({
        rideId,
        _id: { $ne: passenger._id },
        status: { $ne: PASSENGER_STATUS.cancelled },
      });
      const hasOtherPassengers = otherPassengers > 0;

      // ড্রাইভারকে জানান (কোন প্যাসেঞ্জার ক্যানসেল করেছে)
      const remainingSeats = ride.totalSeats - (ride.bookedSeats - passenger.requestedSeats);
      io.to(`driver:${ride.driverId}`).emit('ride:passenger-cancelled', {
        rideId,
        passengerId: passenger._id,
        reason: reason || 'Rider cancelled',
        remainingSeats,
        refundAmount,
        hasOtherPassengers,
      });

      if (!hasOtherPassengers) {
        // শেষ প্যাসেঞ্জার ক্যানসেল করলো → পুরো রাইড বাতিল
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: reason || 'Last passenger cancelled',
          cancelledBy: CANCELLED_BY.user,
          cancelledAt: new Date(),
        });

        await redis.del(`ride:active:${rideId}`);
        await redis.zrem('ride:matching:queue', rideId);
        await redis.del(`ride:request:${rideId}`);

        io.to(`driver:${ride.driverId}`).emit('ride:cancelled', {
          rideId,
          reason: 'All passengers cancelled the ride',
          message: 'The ride has been cancelled as all passengers cancelled.',
        });

        return callback?.({
          success: true,
          message: refundAmount > 0
            ? `Ride cancelled. You were the last passenger. Refund of ${refundAmount} will be processed.`
            : 'Ride cancelled. You were the last passenger.',
          refundAmount,
          rideCancelled: true,
        });
      } else {
        // অন্য প্যাসেঞ্জার আছে → শুধু এই প্যাসেঞ্জার ক্যানসেল
        const remainingPassengers = await Passenger.find({
          rideId,
          _id: { $ne: passenger._id },
          status: { $ne: PASSENGER_STATUS.cancelled },
        }).select('userId');

        for (const p of remainingPassengers) {
          io.to(`user:${p.userId}`).emit('ride:co-passenger-cancelled', {
            rideId,
            cancelledPassengerId: passenger._id,
            remainingSeats,
            message: 'Another passenger has cancelled their booking.',
          });
        }

        return callback?.({
          success: true,
          message: refundAmount > 0
            ? `Booking cancelled. Refund of ${refundAmount} will be processed. Other passengers are still in the ride.`
            : 'Booking cancelled. Other passengers are still in the ride.',
          refundAmount,
          rideCancelled: false,
          remainingPassengers: remainingPassengers.length,
        });
      }
    } catch (error) {
      console.error('Error in rideCancelAfterAcceptHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);