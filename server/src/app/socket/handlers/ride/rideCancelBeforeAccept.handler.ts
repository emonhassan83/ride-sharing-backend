// handlers/ride/rideCancelBeforeAccept.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, CANCELLED_BY, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { modeType } from '../../../modules/notification/notification.interface';
import { notifyUserPush } from '../../../utils/notifyUser.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { transferRideOwnership } from '../../../utils/splitFare.utils';

const notifyDriverCancelled = async (
  io: any,
  driverId: string | undefined | null,
  rideId: string,
  message: string,
) => {
  if (!driverId) return;
  const id = driverId.toString();
  io.to(`driver:${id}`).emit('ride:cancelled', { rideId, message });
  await notifyUserPush({
    userId: id,
    message: 'Ride Cancelled by Rider',
    description: message,
    reference: rideId,
    modelType: modeType.Ride,
    data: { type: 'RIDE_CANCELLED_BY_RIDER', rideId: String(rideId) },
  });
};

const cancelAndNotifyRemaining = async (
  io: any,
  rideId: string,
  remaining: Array<{ _id: any; userId: any }>,
  reason: string,
) => {
  for (const p of remaining) {
    await Passenger.findByIdAndUpdate(p._id, {
      status: PASSENGER_STATUS.cancelled,
      cancellationReason: reason,
      cancelledBy: CANCELLED_BY.user,
    });

    const userId = p.userId?.toString();
    if (!userId) continue;

    io.to(`user:${userId}`).emit('ride:cancelled', {
      rideId,
      message: 'Ride was cancelled because not enough passengers remained.',
    });

    await notifyUserPush({
      userId,
      message: 'Ride Cancelled',
      description: 'Ride was cancelled because not enough passengers remained.',
      reference: rideId,
      modelType: modeType.Ride,
      data: { type: 'RIDE_CANCELLED', rideId: String(rideId) },
    });
  }
};

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
      await notifyDriverCancelled(
        io,
        ride.driverId,
        rideId,
        'Rider cancelled before acceptance.',
      );
      return callback?.({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true } });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────
    if (ride.rideCreatedBy?.toString() === userId) {
      const remainingAfterCreator = await Passenger.find({
        rideId,
        _id: { $ne: passenger._id },
        status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
      }).select('_id userId');

      if (remainingAfterCreator.length <= 1) {
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: remainingAfterCreator.length === 0
            ? 'Creator cancelled before acceptance'
            : 'Creator cancelled, only one passenger remaining. Ride cancelled.',
          cancelledBy: CANCELLED_BY.user, cancelledAt: new Date(),
        });
        await redisCleanup();
        await cancelAndNotifyRemaining(
          io,
          rideId,
          remainingAfterCreator,
          'Only one passenger remaining. Ride cancelled.',
        );
        await notifyDriverCancelled(
          io,
          ride.driverId,
          rideId,
          remainingAfterCreator.length === 0
            ? 'All passengers cancelled.'
            : 'Only one passenger remaining. Ride cancelled.',
        );
        return callback?.({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true } });
      }

      const transferred = await transferRideOwnership(rideId, userId, io);
      if (!transferred) {
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: 'Creator cancelled before acceptance',
          cancelledBy: CANCELLED_BY.user, cancelledAt: new Date(),
        });
        await redisCleanup();
        await notifyDriverCancelled(io, ride.driverId, rideId, 'All passengers cancelled.');
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
      rideId,
      _id: { $ne: passenger._id },
      status: { $ne: PASSENGER_STATUS.cancelled },
    }).select('_id userId');

    if (remaining.length <= 1) {
      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.cancelled,
        cancellationReason: remaining.length === 0
          ? 'Last passenger cancelled'
          : 'Only one passenger remaining. Ride cancelled.',
        cancelledBy: CANCELLED_BY.user, cancelledAt: new Date(),
      });
      await redisCleanup();
      await cancelAndNotifyRemaining(
        io,
        rideId,
        remaining,
        'Only one passenger remaining. Ride cancelled.',
      );
      await notifyDriverCancelled(io, ride.driverId, rideId, 'All passengers cancelled.');
      return callback?.({ success: true, message: 'Ride cancelled.', data: { rideCancelled: true } });
    }

    const remainingSeats = (updatedRide?.totalSeats ?? 0) - (updatedRide?.bookedSeats ?? 0);

    if (ride.driverId) {
      const driverId = ride.driverId.toString();
      io.to(`driver:${driverId}`).emit('ride:passenger-cancelled', {
        rideId, passengerId: passenger._id, remainingSeats,
        message: 'A passenger cancelled.',
      });
      await notifyUserPush({
        userId: driverId,
        message: 'Passenger Cancelled',
        description: 'A passenger cancelled before driver acceptance.',
        reference: rideId,
        modelType: modeType.Ride,
        data: {
          type: 'PASSENGER_CANCELLED',
          rideId: String(rideId),
          passengerId: String(passenger._id),
        },
      });
    }

    for (const p of remaining) {
      const coUserId = p.userId?.toString();
      if (!coUserId) continue;

      io.to(`user:${coUserId}`).emit('ride:co-passenger-cancelled', {
        rideId, cancelledPassengerId: passenger._id, remainingSeats,
        message: 'Another passenger cancelled.',
      });

      await notifyUserPush({
        userId: coUserId,
        message: 'Co-passenger Cancelled',
        description: 'Another passenger cancelled their booking.',
        reference: rideId,
        modelType: modeType.Ride,
        data: {
          type: 'CO_PASSENGER_CANCELLED',
          rideId: String(rideId),
          cancelledPassengerId: String(passenger._id),
        },
      });
    }

    return callback?.({
      success: true,
      message: 'Cancelled successfully.',
      data:    { rideCancelled: false, remainingPassengers: remaining.length },
    });
  },
);
