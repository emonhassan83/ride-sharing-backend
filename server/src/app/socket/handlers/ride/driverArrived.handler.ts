// handlers/driver/driverArrived.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';

export const driverArrivedHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, arriveAll = false, lat, lng } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId)
      return callback?.({ success: false, message: 'Unauthorized' });

    if (!rideId)
      return callback?.({ success: false, message: 'Missing rideId' });

    const ride = await Ride.findById(rideId);
    if (!ride) return callback?.({ success: false, message: 'Ride not found' });

    if (ride.driverId?.toString() !== driverId)
      return callback?.({
        success: false,
        message: 'You are not assigned to this ride',
      });

    // ── Status guard ──────────────────────────────────────────────────────────
    const validStatuses = [RIDE_STATUS.accepted, RIDE_STATUS.started];
    if (!validStatuses.includes(ride.status as any))
      return callback?.({
        success: false,
        message: `Cannot trigger arrived — ride status: ${ride.status}`,
      });

    const io = getIO();
    const redis = getRedisClient();

    // ── Helper: notify single passenger ──────────────────────────────────────
    const notifyPassenger = async (passenger: any, isLastArrival = false) => {
      await Passenger.findByIdAndUpdate(passenger._id, {
        arriveAt: new Date(),
        arrivedNotified: true,
        status: PASSENGER_STATUS.driver_arrived,
      });

      await redis.rpush(
        `ride:${rideId}:live`,
        JSON.stringify({
          driverId,
          event: 'ARRIVED_AT_PICKUP',
          passengerId: passenger._id,
          lat,
          lng,
          timestamp: Date.now(),
        })
      );

      io.to(`user:${passenger.userId}`).emit('ride:driver-arrived', {
        rideId,
        passengerId: passenger._id,
        driverId,
        message: 'Driver has arrived at your pickup location',
        waitingTime: 2,
        isLastArrival,
      });

      console.log(`✅ Notified passenger ${passenger._id}`);

      // Waiting charge timer
      setTimeout(async () => {
        const p = await Passenger.findById(passenger._id);
        if (p?.arriveAt && !p?.pickedUpAt) {
          io.to(`user:${passenger.userId}`).emit('ride:waiting-charge', {
            rideId,
            passengerId: passenger._id,
            message: 'Waiting charges will apply after 2 minutes',
          });
        }
      }, 180000);
    };

    // ── PRIVATE RIDE ──────────────────────────────────────────────────────────
    if (ride.type === RIDE_TYPE.private) {
      const passenger = await Passenger.findOne({
        rideId,
        status: PASSENGER_STATUS.confirmed,
      });

      if (!passenger)
        return callback?.({
          success: false,
          message: 'No active passenger found for this ride',
        });

      await notifyPassenger(passenger, true);

      return callback?.({
        success: true,
        message: 'Driver arrived notification sent',
        data: { passengerId: passenger._id },
      });
    }

    // ── SPLIT RIDE — specific passenger ──────────────────────────────────────
    if (passengerId && !arriveAll) {
      const passenger = await Passenger.findOne({
        _id: passengerId,
        rideId,
        status: PASSENGER_STATUS.confirmed,
      });

      if (!passenger)
        return callback?.({
          success: false,
          message: 'Passenger not found or already notified',
        });

      await notifyPassenger(passenger);

      // Check remaining unnotified
      const remaining = await Passenger.countDocuments({
        rideId,
        status: PASSENGER_STATUS.confirmed,
        arrivedNotified: false,
      });

      return callback?.({
        success: true,
        message: 'Driver arrived notification sent to passenger',
        data: { passengerId: passenger._id, remainingUnnotified: remaining },
      });
    }

    // ── SPLIT RIDE — all passengers ───────────────────────────────────────────
    if (arriveAll) {
      const passengers = await Passenger.find({
        rideId,
        status: PASSENGER_STATUS.confirmed,
        arrivedNotified: false,
      });

      if (!passengers.length)
        return callback?.({
          success: false,
          message: 'No unnotified passengers found for this ride',
        });

      for (let i = 0; i < passengers.length; i++) {
        const isLast = i === passengers.length - 1;
        await notifyPassenger(passengers[i], isLast);
      }

      return callback?.({
        success: true,
        message: `Driver arrived notification sent to ${passengers.length} passenger(s)`,
        data: { notifiedCount: passengers.length },
      });
    }

    return callback?.({
      success: false,
      message:
        'Invalid request: provide passengerId or set arriveAll=true for split ride',
    });
  }
);
