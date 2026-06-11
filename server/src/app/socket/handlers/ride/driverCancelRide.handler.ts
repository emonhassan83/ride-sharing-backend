// handlers/driver/driverCancelRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { CANCELLED_BY, RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { REFUND_STATUS, REFUND_TYPE } from '../../../modules/refund/refund.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { Refund } from '../../../modules/refund/refund.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

// ── Helper: cancel booking + create refund if paid ────────────────────────────
const cancelBookingWithRefund = async (
  passengerId: any,
  rideId: string,
  driverId: string,
  reason: string,
) => {
  const booking = await Booking.findOne({ passengerId });
  if (!booking) return { refundAmount: 0 };

  const paidAmount = booking.amountPaid ?? 0;

  booking.bookingStatus = BOOKING_STATUS.cancelled;
  booking.refundAmount  = paidAmount;
  await booking.save();

  if (paidAmount > 0) {
    const passenger = await Passenger.findById(passengerId).select('userId').lean();
    await Refund.create({
      user:            passenger?.userId,
      ride:            rideId,
      type:            REFUND_TYPE.cancel_ride,
      paymentIntentId: booking.transactionId,
      amount:          paidAmount,
      reason:          `Driver cancelled: ${reason}`,
      note:            `Ride ${rideId} cancelled by driver`,
      status:          REFUND_STATUS.pending,
    });
  }

  return { refundAmount: paidAmount };
};

export const driverCancelRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, reason = '' } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });

    if (ride.driverId?.toString() !== driverId)
      return callback?.({ success: false, message: 'Not assigned to this ride' });

    const cancellableStatuses = [RIDE_STATUS.accepted, RIDE_STATUS.started];
    if (!cancellableStatuses.includes(ride.status as any))
      return callback?.({ success: false, message: 'Cannot cancel now' });

    const redis = getRedisClient();
    const io    = getIO();

    // ── Helper: redis cleanup ─────────────────────────────────────────────────
    const redisCleanup = async () => {
      await Promise.all([
        redis.del(`ride:active:${rideId}`),
        redis.del(`ride:request:${rideId}`),
        redis.del(`driver:${driverId}:activeRide`),
        redis.zrem('ride:matching:queue', rideId),
      ]);
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
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
        return callback?.({ success: false, message: 'No active passenger found' });

      const { refundAmount } = await cancelBookingWithRefund(
        passenger._id, rideId, driverId, reason,
      );

      passenger.status             = PASSENGER_STATUS.cancelled;
      passenger.cancellationReason = reason || 'Driver cancelled';
      passenger.cancelledBy        = CANCELLED_BY.driver;
      await passenger.save();

      await Ride.findByIdAndUpdate(rideId, {
        status:             RIDE_STATUS.cancelled,
        cancellationReason: reason || 'Driver cancelled',
        cancelledBy:        CANCELLED_BY.driver,
        cancelledAt:        new Date(),
      });

      await redis.hincrby(
        `driver:${driverId}:details`,
        'bookedSeats',
        -(passenger.requestedSeats || 1),
      );

      await redisCleanup();

      io.to(`user:${passenger.userId}`).emit('ride:cancelled-by-driver', {
        rideId,
        passengerId: passenger._id,
        reason:      reason || 'Driver cancelled the ride',
        refundAmount,
        message:     refundAmount > 0
          ? 'Your ride has been cancelled by the driver. Full refund will be processed.'
          : 'Your ride has been cancelled by the driver.',
      });

      return callback?.({
        success: true,
        message: 'Private ride cancelled',
        data:    { passengerCount: 1, rideCancelled: true },
      });
    }

    // ── SPLIT RIDE — passengerId required ─────────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required for split ride' });

      const passenger = await Passenger.findOne({
        _id:    passengerId,
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
        return callback?.({ success: false, message: 'Passenger not found or not active' });

      const { refundAmount } = await cancelBookingWithRefund(
        passenger._id, rideId, driverId, reason,
      );

      passenger.status             = PASSENGER_STATUS.cancelled;
      passenger.cancellationReason = reason || 'Driver cancelled passenger';
      passenger.cancelledBy        = CANCELLED_BY.driver;
      await passenger.save();

      await Ride.findByIdAndUpdate(rideId, {
        $inc: { bookedSeats: -(passenger.requestedSeats || 1) },
      });

      await redis.hincrby(
        `driver:${driverId}:details`,
        'bookedSeats',
        -(passenger.requestedSeats || 1),
      );

      io.to(`user:${passenger.userId}`).emit('ride:cancelled-by-driver', {
        rideId,
        passengerId: passenger._id,
        reason:      reason || 'Driver cancelled your booking',
        refundAmount,
        message:     refundAmount > 0
          ? 'Your booking has been cancelled by the driver. Full refund will be processed.'
          : 'Your booking has been cancelled by the driver.',
      });

      // Notify remaining passengers
      const remainingPassengers = await Passenger.find({
        rideId,
        status: {
          $in: [
            PASSENGER_STATUS.confirmed,
            PASSENGER_STATUS.in_progress,
            PASSENGER_STATUS.driver_arrived,
          ],
        },
      }).select('userId');

      const updatedRide    = await Ride.findById(rideId).select('bookedSeats totalSeats').lean();
      const remainingSeats = (updatedRide?.totalSeats ?? 0) - (updatedRide?.bookedSeats ?? 0);

      for (const p of remainingPassengers) {
        io.to(`user:${p.userId}`).emit('ride:co-passenger-cancelled', {
          rideId,
          cancelledPassengerId: passenger._id,
          remainingSeats,
          message: 'A passenger has been removed from the ride by the driver.',
        });
      }

      let rideCancelled = false;
      if (remainingPassengers.length === 0) {
        await Ride.findByIdAndUpdate(rideId, {
          status:             RIDE_STATUS.cancelled,
          cancellationReason: 'No passengers left',
          cancelledBy:        CANCELLED_BY.driver,
          cancelledAt:        new Date(),
        });
        await redisCleanup();
        rideCancelled = true;
      }

      return callback?.({
        success: true,
        message: rideCancelled
          ? 'Last passenger cancelled. Ride cancelled.'
          : 'Passenger cancelled.',
        data: {
          remainingPassengers: remainingPassengers.length,
          rideCancelled,
        },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  },
);