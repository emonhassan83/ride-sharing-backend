// handlers/driver/driverRejectRide.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { getDepartureDateTime } from '../../../utils/rideSchedule.utils';

export const driverRejectRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, reason = '' } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    // Only a driver socket may reject a ride; a rider must not be able to unset the driver.
    if (socket.auth?.role !== 'provider')
      return callback?.({ success: false, message: 'You are not authorized' });

    const ride = await Ride.findById(rideId);
    if (!ride || ride.status !== RIDE_STATUS.pending)
      return callback?.({
        success: false,
        message: 'Ride already accepted or cancelled',
      });

    const redis = getRedisClient();
    const io = getIO();

    // ── Helper: add driver to rejected list ───────────────────────────────────
    const markRejected = async () => {
      await redis.sadd(`ride:rejected:${rideId}`, driverId);
      const departureMs = getDepartureDateTime(
        ride.departureDate,
        ride.departureTime,
      ).getTime();
      const ttlSeconds = Math.max(
        1800,
        Math.floor((departureMs - Date.now()) / 1000) + 7200
      );
      await redis.expire(`ride:rejected:${rideId}`, ttlSeconds);
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = passengerId
        ? await Passenger.findOne({
            _id: passengerId,
            rideId,
            // status: PASSENGER_STATUS.pending,
          })
        : await Passenger.findOne({ rideId, status: PASSENGER_STATUS.pending });
      if (!passenger) {
        return callback?.({
          success: false,
          message: 'Passenger not found or already processed',
        });
      }

      if (passenger) {
        io.to(`user:${passenger.userId}`).emit('ride:driver-rejected', {
          rideId,
          passengerId: passenger._id,
          reason: reason || 'Driver is busy',
          searchingAgain: true,
          rideCancelled: false,
        });
      }

      await markRejected();

      await Ride.findByIdAndUpdate(rideId, {
        $pull: { notifiedDriverIds: driverId },
        $unset: {
          driverId: '',
          vehicleId: '',
        },
      });

      await redis.hset(`ride:request:${rideId}`, {
        matchingStatus: 'driver_rejected_waiting_for_fallback',
        lastRejectedDriverId: driverId,
        lastRejectedAt: Date.now().toString(),
      });

      return callback?.({
        success: true,
        message: 'Private ride rejection recorded. Ride remains pending for fallback matching.',
        data: { passengerCount: passenger ? 1 : 0, rideCancelled: false },
      });
    }

    // ── SPLIT RIDE ────────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.split) {
      // The ride is still pending here, so no driver owns it yet. A decline only
      // means "not for me": this driver stops seeing the card and the riders
      // keep their bookings for the other drivers, as for a private ride.
      //
      // Accept-failed bug: a decline that carried a passengerId (the request card
      // row `_id` IS a passenger id) used to mark that rider `rejected` and, when
      // they were the only rider, cancel the whole ride. No other notified driver
      // was told, so their still-visible card failed with "already accepted or
      // cancelled". The rider was told "searching again" while the ride was dead
      // and their card hold was never released.
      await markRejected();
      await Ride.findByIdAndUpdate(rideId, { $pull: { notifiedDriverIds: driverId } });
      return callback?.({
        success: true,
        message: 'Ride declined. It stays available to other drivers.',
        data: { rideCancelled: false, ...(passengerId ? { passengerId } : {}) },
      });
    }

    return callback?.({ success: false, message: 'Unknown ride type' });
  }
);




