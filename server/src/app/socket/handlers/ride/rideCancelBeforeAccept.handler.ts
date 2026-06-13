// handlers/ride/rideCancelBeforeAccept.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, CANCELLED_BY, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { transferRideOwnership } from '../../../utils/splitFare.utils';

export const rideCancelBeforeAcceptHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, reason = '' } = data;
    const userId = socket.auth?._id?.toString();

    if (!rideId || !userId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });
    if (ride.status !== RIDE_STATUS.pending)
      return callback?.({ success: false, message: 'Cannot cancel: driver already accepted' });

    const passenger = await Passenger.findOne({ rideId, userId, status: PASSENGER_STATUS.pending });
    if (!passenger)
      return callback?.({ success: false, message: 'No pending booking found' });

    const redis = getRedisClient();
    const io    = getIO();

    await Passenger.findByIdAndUpdate(passenger._id, {
      status:             PASSENGER_STATUS.cancelled,
      cancellationReason: reason || 'Cancelled by rider',
      cancelledBy:        CANCELLED_BY.user,
    });

    const redisCleanup = async () => {
      await Promise.all([
        redis.zrem('ride:matching:queue', rideId),
        redis.del(`ride:request:${rideId}`),
      ]);
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.cancelled,
        cancellationReason: reason || 'Cancelled by rider',
        cancelledBy: CANCELLED_BY.user, cancelledAt: new Date(),
      });
      await redisCleanup();
      if (ride.driverId) {
        io.to(`driver:${ride.driverId}`).emit('ride:cancelled', {
          rideId, message: 'Rider cancelled before acceptance.',
        });
      }
      return callback?.({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true } });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────
    // Case 3: was this the rideCreatedBy?
    if (ride.rideCreatedBy?.toString() === userId) {
      const transferred = await transferRideOwnership(rideId, userId, io);
      if (!transferred) {
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: 'Creator cancelled before acceptance',
          cancelledBy: CANCELLED_BY.user, cancelledAt: new Date(),
        });
        await redisCleanup();
        if (ride.driverId) {
          io.to(`driver:${ride.driverId}`).emit('ride:cancelled', {
            rideId, message: 'All passengers cancelled.',
          });
        }
        return callback?.({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true } });
      }
    }

    // Decrement seats
    const updatedRide = await Ride.findByIdAndUpdate(
      rideId,
      { $inc: { bookedSeats: -(passenger.requestedSeats || 1) } },
      { returnDocument: 'after' },
    ).lean();

    const remaining = await Passenger.find({
      rideId, _id: { $ne: passenger._id }, status: { $ne: PASSENGER_STATUS.cancelled },
    }).select('userId');

    if (remaining.length === 0) {
      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.cancelled,
        cancellationReason: 'Last passenger cancelled',
        cancelledBy: CANCELLED_BY.user, cancelledAt: new Date(),
      });
      await redisCleanup();
      if (ride.driverId) {
        io.to(`driver:${ride.driverId}`).emit('ride:cancelled', {
          rideId, message: 'All passengers cancelled.',
        });
      }
      return callback?.({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true } });
    }

    const remainingSeats = (updatedRide?.totalSeats ?? 0) - (updatedRide?.bookedSeats ?? 0);

    if (ride.driverId) {
      io.to(`driver:${ride.driverId}`).emit('ride:passenger-cancelled', {
        rideId, passengerId: passenger._id, remainingSeats,
        message: 'A passenger cancelled.',
      });
    }

    for (const p of remaining) {
      io.to(`user:${p.userId}`).emit('ride:co-passenger-cancelled', {
        rideId, cancelledPassengerId: passenger._id, remainingSeats,
        message: 'Another passenger cancelled.',
      });
    }

    return callback?.({
      success: true,
      message: 'Cancelled successfully.',
      data:    { rideCancelled: false, remainingPassengers: remaining.length },
    });
  },
);