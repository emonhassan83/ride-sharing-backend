// handlers/ride/rideCancelAfterAccept.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, CANCELLED_BY, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import {
  calculateCancellationRefund,
  recalculateSplitFares,
  refundToWallet,
  transferRideOwnership,
} from '../../../utils/splitFare.utils';

export const rideCancelAfterAcceptHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, reason = '' } = data; // ✅ passengerId added
    const userId = socket.auth?._id?.toString();

    if (!rideId || !userId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const io    = getIO();
    const redis = getRedisClient();

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });

    if (![RIDE_STATUS.accepted, RIDE_STATUS.started].includes(ride.status as any))
      return callback?.({ success: false, message: 'Cannot cancel at this stage' });

    // ── Find passenger ────────────────────────────────────────────────────────
    // Private: userId দিয়ে খোঁজো
    // Split: passengerId দিয়ে খোঁজো (same user একাধিক split ride এ থাকতে পারে)
    let passenger: any;

    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required for split ride cancellation' });

      passenger = await Passenger.findOne({
        _id:    passengerId,
        rideId,
        userId, // ✅ security check — must be the owner
        status: { $in: [PASSENGER_STATUS.confirmed, PASSENGER_STATUS.driver_arrived, PASSENGER_STATUS.pending] },
      });
    } else {
      passenger = await Passenger.findOne({
        rideId,
        userId,
        status: { $in: [PASSENGER_STATUS.confirmed, PASSENGER_STATUS.driver_arrived, PASSENGER_STATUS.pending] },
      });
    }

    if (!passenger)
      return callback?.({ success: false, message: 'No active booking found' });

    const booking      = await Booking.findOne({ passengerId: passenger._id }).lean();
    const paidAmount   = booking?.amountPaid ?? passenger.estimatedFare ?? 0;

    // ── Cancellation refund (Cases 20, 21) ────────────────────────────────────
    const departureDateTime = new Date(`${ride.departureDate}T${ride.departureTime}:00`);
    const { refundAmount, platformAmount, refundReason } = await calculateCancellationRefund(
      paidAmount,
      (passenger as any).createdAt || new Date(),
      departureDateTime,
    );

    // ── Update passenger ──────────────────────────────────────────────────────
    await Passenger.findByIdAndUpdate(passenger._id, {
      status:             PASSENGER_STATUS.cancelled,
      cancellationReason: reason || 'Rider cancelled',
      cancelledBy:        CANCELLED_BY.user,
      refundAmount,
    });

    await Booking.findOneAndUpdate(
      { passengerId: passenger._id },
      { bookingStatus: BOOKING_STATUS.cancelled, refundAmount },
    );

    // ── Refund to wallet (Case 26) ────────────────────────────────────────────
    if (refundAmount > 0) {
      await refundToWallet(userId, refundAmount, `cancel_${refundReason}`, io);
    }

    if (platformAmount > 0) {
      console.log(`💼 Platform revenue £${platformAmount} | ride ${rideId} | reason: ${refundReason}`);
    }

    // ── Decrement seats ───────────────────────────────────────────────────────
    await Ride.findByIdAndUpdate(rideId, {
      $inc: { bookedSeats: -(passenger.requestedSeats || 1) },
    });
    if (ride.driverId) {
      await redis.hincrby(
        `driver:${ride.driverId}:details`,
        'bookedSeats',
        -(passenger.requestedSeats || 1),
      );
    }

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      await Ride.findByIdAndUpdate(rideId, {
        status:             RIDE_STATUS.cancelled,
        cancellationReason: reason || 'Rider cancelled',
        cancelledBy:        CANCELLED_BY.user,
        cancelledAt:        new Date(),
      });

      await Promise.all([
        redis.del(`ride:active:${rideId}`),
        redis.zrem('ride:matching:queue', rideId),
        redis.del(`ride:request:${rideId}`),
      ]);

      if (ride.driverId) {
        io.to(`driver:${ride.driverId}`).emit('ride:cancelled-by-rider', {
          rideId, reason, refundAmount,
          message: 'Rider cancelled the ride.',
        });
      }

      return callback?.({
        success: true,
        message: 'Ride cancelled.',
        data:    { refundAmount, refundReason, rideCancelled: true },
      });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────

    // Case 3: rideCreatedBy cancelled → transfer ownership
    if (ride.rideCreatedBy?.toString() === userId) {
      const transferred = await transferRideOwnership(rideId, userId, io);
      if (!transferred) {
        // No other passengers — cancel ride
        await Ride.findByIdAndUpdate(rideId, {
          status:             RIDE_STATUS.cancelled,
          cancellationReason: 'Creator cancelled, no passengers remaining',
          cancelledBy:        CANCELLED_BY.user,
          cancelledAt:        new Date(),
        });
        await Promise.all([
          redis.del(`ride:active:${rideId}`),
          redis.zrem('ride:matching:queue', rideId),
        ]);
        if (ride.driverId) {
          io.to(`driver:${ride.driverId}`).emit('ride:cancelled-by-rider', {
            rideId, message: 'Ride creator cancelled. No passengers remaining.',
          });
        }
        return callback?.({
          success: true,
          message: 'Ride cancelled — no other passengers.',
          data:    { refundAmount, refundReason, rideCancelled: true },
        });
      }
    }

    // Check remaining active passengers
    const remainingCount = await Passenger.countDocuments({
      rideId,
      status: { $nin: ['cancelled', 'rejected'] },
    });

    if (remainingCount === 0) {
      // Last passenger cancelled → cancel ride
      await Ride.findByIdAndUpdate(rideId, {
        status:             RIDE_STATUS.cancelled,
        cancellationReason: 'Last passenger cancelled',
        cancelledBy:        CANCELLED_BY.user,
        cancelledAt:        new Date(),
      });
      await Promise.all([
        redis.del(`ride:active:${rideId}`),
        redis.zrem('ride:matching:queue', rideId),
      ]);
      if (ride.driverId) {
        io.to(`driver:${ride.driverId}`).emit('ride:cancelled', {
          rideId, message: 'All passengers cancelled. Ride is now cancelled.',
        });
      }
      return callback?.({
        success: true,
        message: 'Ride cancelled — you were the last passenger.',
        data:    { refundAmount, refundReason, rideCancelled: true },
      });
    }

    // Recalculate fares for remaining (Cases 6, 29, 30)
    await recalculateSplitFares(rideId, 'passenger_cancelled', io);

    // Notify driver
    if (ride.driverId) {
      io.to(`driver:${ride.driverId}`).emit('ride:passenger-cancelled', {
        rideId,
        passengerId:         passenger._id,
        remainingPassengers: remainingCount,
        message:             'A passenger cancelled their booking.',
      });
    }

    // Notify co-passengers
    const others = await Passenger.find({
      rideId,
      _id:    { $ne: passenger._id },
      status: { $nin: ['cancelled', 'rejected'] },
    }).select('userId');

    for (const p of others) {
      io.to(`user:${p.userId}`).emit('ride:co-passenger-cancelled', {
        rideId,
        cancelledPassengerId: passenger._id,
        message:              'Another passenger cancelled their booking.',
      });
    }

    return callback?.({
      success: true,
      message: 'Booking cancelled.',
      data: {
        passengerId:         passenger._id,
        refundAmount,
        refundReason,
        rideCancelled:       false,
        remainingPassengers: remainingCount,
      },
    });
  },
);