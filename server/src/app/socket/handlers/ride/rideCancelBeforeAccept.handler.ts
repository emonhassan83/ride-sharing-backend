// handlers/ride/rideCancelBeforeAccept.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, CANCELLED_BY, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

export const rideCancelBeforeAcceptHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, reason } = data;
    const userId = socket.auth?._id?.toString();

    if (!rideId || !userId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });

    if (ride.status !== RIDE_STATUS.pending)
      return callback?.({ success: false, message: 'Cannot cancel: driver already accepted or ride started' });

    const passenger = await Passenger.findOne({ rideId, userId });
    if (!passenger)
      return callback?.({ success: false, message: 'You are not a passenger in this ride' });

    if (passenger.status !== PASSENGER_STATUS.pending)
      return callback?.({ success: false, message: 'Already cancelled or confirmed' });

    const redis = getRedisClient();
    const io    = getIO();

    // ── Helper: cancel passenger ──────────────────────────────────────────────
    const cancelPassenger = async () => {
      passenger.status              = PASSENGER_STATUS.cancelled;
      passenger.cancellationReason  = reason || 'Cancelled by rider';
      passenger.cancelledBy         = CANCELLED_BY.user;
      await passenger.save();
    };

    // ── Helper: notify driver ─────────────────────────────────────────────────
    const notifyDriver = (message: string) => {
      if (ride.driverId) {
        io.to(`driver:${ride.driverId}`).emit('ride:cancelled', {
          rideId,
          passengerId:  passenger._id,
          cancelledBy:  'rider',
          message,
        });
      }
    };

    // ── Helper: redis cleanup ─────────────────────────────────────────────────
    const redisCleanup = async () => {
      await Promise.all([
        redis.zrem('ride:matching:queue', rideId),
        redis.del(`ride:request:${rideId}`),
      ]);
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      await cancelPassenger();

      await Ride.findByIdAndUpdate(rideId, {
        status:              RIDE_STATUS.cancelled,
        cancellationReason:  reason || 'Cancelled by rider (before acceptance)',
        cancelledBy:         CANCELLED_BY.user,
        cancelledAt:         new Date(),
      });

      await redisCleanup();

      // ✅ Notify driver
      notifyDriver('Rider has cancelled the ride request.');

      // Notify rider
      io.to(`user:${userId}`).emit('ride:cancelled', {
        rideId,
        message:      'Private ride cancelled successfully',
        refundAmount: 0,
      });

      return callback?.({
        success:      true,
        message:      'Private ride cancelled successfully',
        refundAmount: 0,
      });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────
    const otherActiveCount = await Passenger.countDocuments({
      rideId,
      _id:    { $ne: passenger._id },
      status: { $ne: PASSENGER_STATUS.cancelled },
    });

    await cancelPassenger();

    if (otherActiveCount === 0) {
      // Last passenger — cancel the whole ride
      await Ride.findByIdAndUpdate(rideId, {
        status:             RIDE_STATUS.cancelled,
        cancellationReason: reason || 'Last passenger cancelled before acceptance',
        cancelledBy:        CANCELLED_BY.user,
        cancelledAt:        new Date(),
      });

      await redisCleanup();

      // ✅ Notify driver
      notifyDriver('All passengers cancelled. Ride has been cancelled.');

      io.to(`user:${userId}`).emit('ride:cancelled', {
        rideId,
        message:      'Ride cancelled (you were the only passenger)',
        refundAmount: 0,
      });

      return callback?.({
        success:      true,
        message:      'Ride cancelled successfully',
        refundAmount: 0,
      });
    }

    // Other passengers still in the ride — only remove this passenger
    const updatedRide = await Ride.findByIdAndUpdate(
      rideId,
      { $inc: { bookedSeats: -passenger.requestedSeats } },
      { new: true },
    ).lean();

    const remainingSeats = (updatedRide?.totalSeats ?? 0) - (updatedRide?.bookedSeats ?? 0);

    // ✅ Notify driver — one passenger left
    if (ride.driverId) {
      io.to(`driver:${ride.driverId}`).emit('ride:passenger-cancelled', {
        rideId,
        passengerId:    passenger._id,
        cancelledBy:    'rider',
        remainingSeats,
        message:        'A passenger has cancelled their request.',
      });
    }

    // Notify rider
    io.to(`user:${userId}`).emit('ride:passenger-cancelled', {
      rideId,
      message: 'You have been removed from the ride.',
    });

    // Notify remaining passengers
    const remainingPassengers = await Passenger.find({
      rideId,
      _id:    { $ne: passenger._id },
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
      success:      true,
      message:      'Cancelled successfully',
      refundAmount: 0,
    });
  },
);