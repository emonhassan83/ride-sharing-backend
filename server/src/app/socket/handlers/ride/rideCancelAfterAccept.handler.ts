// handlers/ride/rideCancelAfterAccept.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import {
  RIDE_STATUS,
  CANCELLED_BY,
  RIDE_TYPE,
} from '../../../modules/ride/ride.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { Refund } from '../../../modules/refund/refund.model';
import { REFUND_STATUS, REFUND_TYPE } from '../../../modules/refund/refund.constant';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

function getDepartureDateTime(dateStr: string, timeStr: string): Date {
  return new Date(`${dateStr}T${timeStr}:00`);
}

function calculateRefundAmount(
  departureDateTime: Date,
  cancelTime: Date,
  paidAmount: number
): number {
  if (!paidAmount || paidAmount <= 0) return 0;
  const hoursDiff =
    (departureDateTime.getTime() - cancelTime.getTime()) / (1000 * 60 * 60);
  if (hoursDiff < 0) return 0;
  if (hoursDiff >= 24) return paidAmount;
  if (hoursDiff >= 5) return paidAmount * 0.5;
  return 0;
}

export const rideCancelAfterAcceptHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, reason } = data;
    const userId = socket.auth?._id?.toString();

    if (!rideId || !userId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const ride = await Ride.findById(rideId);
    if (!ride) return callback?.({ success: false, message: 'Ride not found' });

    const cancellableStatuses = [RIDE_STATUS.accepted, RIDE_STATUS.started];
    if (!cancellableStatuses.includes(ride.status as any))
      return callback?.({
        success: false,
        message: 'Cannot cancel now: trip already completed',
      });

    const passenger = await Passenger.findOne({ rideId, userId });
    if (!passenger)
      return callback?.({
        success: false,
        message: 'You are not a passenger in this ride',
      });

    const passengerCancellableStatuses = [
      PASSENGER_STATUS.confirmed,
      PASSENGER_STATUS.in_progress,
      PASSENGER_STATUS.driver_arrived,
    ];
    if (!passengerCancellableStatuses.includes(passenger.status as any))
      return callback?.({
        success: false,
        message: 'Already cancelled or not yet accepted',
      });

    const booking = await Booking.findOne({ passengerId: passenger._id });
    if (!booking)
      return callback?.({ success: false, message: 'Booking not found' });

    const redis = getRedisClient();
    const io = getIO();

    // ── Refund calculation ────────────────────────────────────────────────────
    const paidAmount = booking.amountPaid ?? 0;
    const cancelTime = new Date();
    const departureDateTime = getDepartureDateTime(
      ride.departureDate,
      ride.departureTime
    );
    const refundAmount = calculateRefundAmount(
      departureDateTime,
      cancelTime,
      paidAmount
    );

    // ── Cancel passenger & booking ────────────────────────────────────────────
    passenger.status = PASSENGER_STATUS.cancelled;
    passenger.cancellationReason =
      reason || 'Cancelled by rider after acceptance';
    passenger.cancelledBy = CANCELLED_BY.user;
    await passenger.save();

    booking.bookingStatus = BOOKING_STATUS.cancelled;
    booking.refundAmount = refundAmount;
    await booking.save();

    // ── Create refund only if paid and refund amount > 0 ─────────────────────
    if (paidAmount > 0 && refundAmount > 0) {
      await Refund.create({
        user: userId,
        ride: ride._id,
        type: REFUND_TYPE.cancel_ride,
        paymentIntentId: booking.transactionId,
        amount: refundAmount,
        reason: `Cancellation: ${reason || 'Rider cancelled after acceptance'}`,
        note: `Ride ${rideId} cancelled by rider. Departure: ${ride.departureDate} ${ride.departureTime}`,
        status: REFUND_STATUS.pending,
      });
    }

    // ── Decrement booked seats ────────────────────────────────────────────────
    await Ride.findByIdAndUpdate(rideId, {
      $inc: { bookedSeats: -passenger.requestedSeats },
    });

    if (ride.driverId) {
      await redis.hincrby(
        `driver:${ride.driverId}:details`,
        'bookedSeats',
        -passenger.requestedSeats
      );
    }

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.cancelled,
        cancellationReason:
          reason || 'Private ride cancelled by rider after acceptance',
        cancelledBy: CANCELLED_BY.user,
        cancelledAt: new Date(),
      });

      io.to(`driver:${ride.driverId}`).emit('ride:cancelled-by-rider', {
        rideId,
        passengerId: passenger._id,
        reason: reason || 'Rider cancelled the ride',
        refundAmount,
        message: 'Ride has been cancelled by the rider',
      });

      await Promise.all([
        redis.del(`ride:active:${rideId}`),
        redis.zrem('ride:matching:queue', rideId),
        redis.del(`ride:request:${rideId}`),
      ]);

      return callback?.({
        success: true,
        message:
          paidAmount > 0 && refundAmount > 0
            ? `Private ride cancelled. Refund of ${refundAmount} will be processed.`
            : 'Private ride cancelled.',
        data: {
          refundAmount,
          rideCancelled: true,
        },
      });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────
    const otherCount = await Passenger.countDocuments({
      rideId,
      _id: { $ne: passenger._id },
      status: { $ne: PASSENGER_STATUS.cancelled },
    });
    const hasOtherPassengers = otherCount > 0;

    const updatedRide = await Ride.findById(rideId)
      .select('bookedSeats totalSeats')
      .lean();
    const remainingSeats =
      (updatedRide?.totalSeats ?? 0) - (updatedRide?.bookedSeats ?? 0);

    io.to(`driver:${ride.driverId}`).emit('ride:passenger-cancelled', {
      rideId,
      passengerId: passenger._id,
      reason: reason || 'Rider cancelled',
      remainingSeats,
      refundAmount,
      hasOtherPassengers,
    });

    if (!hasOtherPassengers) {
      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.cancelled,
        cancellationReason: reason || 'Last passenger cancelled',
        cancelledBy: CANCELLED_BY.user,
        cancelledAt: new Date(),
      });

      await Promise.all([
        redis.del(`ride:active:${rideId}`),
        redis.zrem('ride:matching:queue', rideId),
        redis.del(`ride:request:${rideId}`),
      ]);

      io.to(`driver:${ride.driverId}`).emit('ride:cancelled', {
        rideId,
        reason: 'All passengers cancelled the ride',
        message: 'The ride has been cancelled as all passengers cancelled.',
      });

      return callback?.({
        success: true,
        message:
          paidAmount > 0 && refundAmount > 0
            ? `Ride cancelled. Refund of ${refundAmount} will be processed.`
            : 'Ride cancelled. You were the last passenger.',
        data: {
          refundAmount,
          rideCancelled: true,
        },
      });
    }

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
      message:
        paidAmount > 0 && refundAmount > 0
          ? `Booking cancelled. Refund of ${refundAmount} will be processed. Other passengers are still in the ride.`
          : 'Booking cancelled. Other passengers are still in the ride.',
      data: {
        refundAmount,
        rideCancelled: false,
        remainingPassengers: remainingPassengers.length,
      },
    });
  }
);
