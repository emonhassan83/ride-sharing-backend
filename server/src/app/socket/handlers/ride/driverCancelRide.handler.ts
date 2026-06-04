// handlers/driver/driverCancelRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import {
  CANCELLED_BY,
  RIDE_STATUS,
  RIDE_TYPE,
} from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { REFUND_STATUS } from '../../../modules/refund/refund.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { Refund } from '../../../modules/refund/refund.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

/**
 * Driver cancels ride after accepting but before trip starts
 *
 * কেস ১: স্প্লিট রাইড
 *   ১.ক: নির্দিষ্ট প্যাসেঞ্জার ক্যানসেল (passengerId দিয়ে) → শুধু ঐ প্যাসেঞ্জার ক্যানসেল হবে
 *   ১.খ: পুরো রাইড ক্যানসেল (cancelType = 'all') → সব প্যাসেঞ্জার ক্যানসেল হবে
 *
 * কেস ২: প্রাইভেট রাইড → পুরো রাইড ক্যানসেল হবে
 *
 * নোট: রেটিং পরিবর্তন করা হবে না (স্কিপ)
 */

export const driverCancelRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    let { rideId, passengerId, reason, cancelType = 'all' } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId) {
      return callback?.({ success: false, message: 'Missing required fields' });
    }

    try {
      const ride = await Ride.findById(rideId);
      if (!ride)
        return callback?.({ success: false, message: 'Ride not found' });
      if (ride.driverId?.toString() !== driverId)
        return callback?.({
          success: false,
          message: 'Not assigned to this ride',
        });

      // শুধুমাত্র accepted স্টেটে ক্যানসেল করা যাবে
      const cancellableStatuses = [RIDE_STATUS.accepted, RIDE_STATUS.started];
      if (!cancellableStatuses.includes(ride.status as any)) {
        return callback?.({
          success: false,
          message: 'Cannot cancel now: trip already in progress or completed',
        });
      }

      const redis = getRedisClient();
      const io = getIO();

      // ========== প্রাইভেট রাইড ==========
      if (ride.type === RIDE_TYPE.private) {
        const passenger = await Passenger.findOne({
          rideId,
          status: {
            $in: [
              PASSENGER_STATUS.confirmed,
              PASSENGER_STATUS.in_progress,
              PASSENGER_STATUS.driver_arrived,
            ],
          },
        });
        if (!passenger)
          return callback?.({
            success: false,
            message: 'No matched passenger',
          });

        const booking = await Booking.findOne({ passengerId: passenger._id });
        if (booking && booking.amountPaid > 0) {
          await Refund.create({
            user: passenger.userId,
            order: booking._id,
            paymentIntentId: booking.transactionId,
            amount: booking.amountPaid,
            reason: `Driver cancelled private ride: ${reason || ''}`,
            note: `Ride ${rideId} cancelled by driver`,
            status: REFUND_STATUS.pending,
          });
        }

        passenger.status = PASSENGER_STATUS.cancelled;
        passenger.cancellationReason = reason || 'Driver cancelled';
        passenger.cancelledBy = CANCELLED_BY.driver;
        await passenger.save();

        if (booking) {
          booking.bookingStatus = BOOKING_STATUS.cancelled;
          booking.refundAmount = booking.amountPaid;
          await booking.save();
        }

        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: reason || 'Driver cancelled',
          cancelledBy: CANCELLED_BY.driver,
          cancelledAt: new Date(),
        });

        io.to(`user:${passenger.userId}`).emit('ride:cancelled-by-driver', {
          rideId,
          passengerId: passenger._id,
          reason: reason || 'Driver cancelled the ride',
          refundAmount: booking?.amountPaid || 0,
          message:
            'Your ride has been cancelled by the driver. Full refund will be processed.',
        });

        await redis.del(`ride:active:${rideId}`);
        await redis.del(`ride:request:${rideId}`);
        await redis.zrem('ride:matching:queue', rideId);
        await redis.del(`driver:${driverId}:activeRide`);
        await redis.hincrby(
          `driver:${driverId}:details`,
          'bookedSeats',
          -(passenger.requestedSeats || 1)
        );

        return callback?.({
          success: true,
          message: 'Private ride cancelled',
          data: {
            passengerCount: 1,
            rideCancelled: true,
          },
        });
      }

      // ========== স্প্লিট রাইড ==========
      // কেস ১.ক: নির্দিষ্ট প্যাসেঞ্জার ক্যানসেল
      if (cancelType === 'single' && passengerId) {
        const passenger = await Passenger.findOne({
          _id: passengerId,
          rideId,
          status: PASSENGER_STATUS.confirmed,
        });
        if (!passenger)
          return callback?.({
            success: false,
            message: 'Passenger not found or not confirmed',
          });

        const booking = await Booking.findOne({ passengerId: passenger._id });
        if (booking && booking.amountPaid > 0) {
          await Refund.create({
            user: passenger.userId,
            order: booking._id,
            paymentIntentId: booking.transactionId,
            amount: booking.amountPaid,
            reason: `Driver cancelled passenger: ${reason || ''}`,
            note: `Ride ${rideId} - passenger ${passengerId} cancelled`,
            status: REFUND_STATUS.pending,
          });
        }

        passenger.status = PASSENGER_STATUS.cancelled;
        passenger.cancellationReason = reason || 'Driver cancelled passenger';
        passenger.cancelledBy = CANCELLED_BY.driver;
        await passenger.save();

        if (booking) {
          booking.bookingStatus = BOOKING_STATUS.cancelled;
          booking.refundAmount = booking.amountPaid;
          await booking.save();
        }

        await Ride.findByIdAndUpdate(rideId, {
          $inc: { bookedSeats: -(passenger.requestedSeats || 1) },
        });
        await redis.hincrby(
          `driver:${driverId}:details`,
          'bookedSeats',
          -(passenger.requestedSeats || 1)
        );

        io.to(`user:${passenger.userId}`).emit('ride:cancelled-by-driver', {
          rideId,
          passengerId: passenger._id,
          reason: reason || 'Driver cancelled your booking',
          refundAmount: booking?.amountPaid || 0,
          message:
            'Your booking has been cancelled by the driver. Full refund will be processed.',
        });

        // ✅ অন্য প্যাসেঞ্জারদের নোটিফিকেশন
        const remainingPassengers = await Passenger.find({
          rideId,
          status: PASSENGER_STATUS.confirmed,
        }).select('userId');
        for (const p of remainingPassengers) {
          io.to(`user:${p.userId}`).emit('ride:co-passenger-cancelled', {
            rideId,
            cancelledPassengerId: passenger._id,
            remainingSeats:
              ride.totalSeats -
              (ride.bookedSeats - (passenger.requestedSeats || 1)),
            message:
              'A passenger has been removed from the ride by the driver.',
          });
        }

        let rideCancelled = false;
        if (remainingPassengers.length === 0) {
          await Ride.findByIdAndUpdate(rideId, {
            status: RIDE_STATUS.cancelled,
            cancellationReason: 'No passengers left',
            cancelledBy: CANCELLED_BY.driver,
          });
          await redis.del(`ride:active:${rideId}`);
          await redis.zrem('ride:matching:queue', rideId);
          rideCancelled = true;
        }

        return callback?.({
          success: true,
          message:
            remainingPassengers.length === 0
              ? 'Last passenger cancelled. Ride cancelled.'
              : 'Passenger cancelled.',
          data: {
            remainingPassengers: remainingPassengers.length,
            rideCancelled,
          },
        });
      }

      // কেস ১.খ: পুরো রাইড ক্যানসেল (সব প্যাসেঞ্জার)
      if (cancelType === 'all') {
        const passengers = await Passenger.find({
          rideId,
          status: PASSENGER_STATUS.confirmed,
        });
        if (passengers.length === 0)
          return callback?.({
            success: false,
            message: 'No confirmed passengers',
          });

        const totalSeats = passengers.reduce(
          (sum, p) => sum + (p.requestedSeats || 1),
          0
        );
        for (const passenger of passengers) {
          const booking = await Booking.findOne({ passengerId: passenger._id });
          if (booking && booking.amountPaid > 0) {
            await Refund.create({
              user: passenger.userId,
              order: booking._id,
              paymentIntentId: booking.transactionId,
              amount: booking.amountPaid,
              reason: `Driver cancelled entire ride: ${reason || ''}`,
              note: `Ride ${rideId} fully cancelled by driver`,
              status: REFUND_STATUS.pending,
            });
          }

          passenger.status = PASSENGER_STATUS.cancelled;
          passenger.cancellationReason =
            reason || 'Driver cancelled entire ride';
          passenger.cancelledBy = CANCELLED_BY.driver;
          await passenger.save();

          if (booking) {
            booking.bookingStatus = BOOKING_STATUS.cancelled;
            booking.refundAmount = booking.amountPaid;
            await booking.save();
          }

          io.to(`user:${passenger.userId}`).emit('ride:cancelled-by-driver', {
            rideId,
            passengerId: passenger._id,
            reason: reason || 'Driver cancelled the ride',
            refundAmount: booking?.amountPaid || 0,
            message:
              'Your ride has been cancelled by the driver. Full refund will be processed.',
          });
        }

        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: reason || 'Driver cancelled entire ride',
          cancelledBy: CANCELLED_BY.driver,
          cancelledAt: new Date(),
        });
        await redis.del(`ride:active:${rideId}`);
        await redis.del(`ride:request:${rideId}`);
        await redis.zrem('ride:matching:queue', rideId);
        await redis.del(`driver:${driverId}:activeRide`);
        await redis.hincrby(
          `driver:${driverId}:details`,
          'bookedSeats',
          -totalSeats
        );

        return callback?.({
          success: true,
          message: 'Ride cancelled. All passengers refunded.',
          data: {
            passengerCount: passengers.length,
            rideCancelled: true,
          },
        });
      }

      callback?.({
        success: false,
        message: 'Invalid cancelType or missing passengerId',
      });
    } catch (error) {
      console.error('Error in driverCancelRideHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);
