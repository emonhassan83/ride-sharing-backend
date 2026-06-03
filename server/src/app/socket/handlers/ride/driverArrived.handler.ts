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
  async (socket: TSocket, data: any) => {
    const { rideId, passengerId, arriveAll = false, lat, lng } = data;
    const driverId = socket.auth?._id?.toString();

    if (!rideId) {
      console.error('❌ Missing rideId');
      return;
    }

    const ride = await Ride.findById(rideId);
    if (!ride) {
      console.error(`❌ Ride not found: ${rideId}`);
      return;
    }

    // ── Guard: only allow arrived trigger for valid statuses ─────────────────
    const validStatuses = [
      RIDE_STATUS.accepted,
      RIDE_STATUS.driver_assigned,
      RIDE_STATUS.driver_arrived, // re-notify যদি কেউ miss করে
    ];
    if (!validStatuses.includes(ride.status as any)) {
      console.log(`⏭️ Cannot trigger arrived — ride status: ${ride.status}`);
      return;
    }

    const io = getIO();
    const redis = getRedisClient();

    const notifyPassenger = async (passenger: any, isLastArrival = false) => {
      // Update passenger
      await Passenger.findByIdAndUpdate(passenger._id, {
        arriveAt: new Date(),
        arrivedNotified: true,
        status: PASSENGER_STATUS.driver_arrived,
      });

      // Redis log
      await redis.rpush(
        `ride:${rideId}:live`,
        JSON.stringify({
          driverId,
          event: 'ARRIVED_AT_PICKUP',
          passengerId: passenger._id,
          lat,
          lng,
          timestamp: Date.now(),
        }),
      );

      // Notify passenger
      io.to(`user:${passenger.userId}`).emit('ride:driver-arrived', {
        rideId,
        passengerId: passenger._id,
        driverId,
        message: 'Driver has arrived at your pickup location',
        waitingTime: 2,
        isLastArrival,
      });

      console.log(`✅ Notified passenger ${passenger._id}`);

      // Waiting charge timer (3 min)
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
        status: { $in: [PASSENGER_STATUS.matched, PASSENGER_STATUS.confirmed] },
      });

      if (!passenger) {
        console.log(`⚠️ No active passenger for private ride ${rideId}`);
        return;
      }

      // Update ride status
      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.driver_arrived,
        arrivedAt: new Date(),
      });

      await notifyPassenger(passenger, true);
      return;
    }

    // ── SPLIT RIDE — specific passenger ──────────────────────────────────────
    if (passengerId && !arriveAll) {
      const passenger = await Passenger.findOne({
        _id: passengerId,
        rideId,
        status: { $in: [PASSENGER_STATUS.matched, PASSENGER_STATUS.confirmed] },
      });

      if (!passenger) {
        console.log(`⚠️ Passenger ${passengerId} not found or invalid status`);
        return;
      }

      await notifyPassenger(passenger);

      // Check if ALL passengers are now notified
      const remaining = await Passenger.countDocuments({
        rideId,
        status: { $in: [PASSENGER_STATUS.matched, PASSENGER_STATUS.confirmed] },
        arrivedNotified: false,
      });

      if (remaining === 0) {
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.driver_arrived,
          arrivedAt: new Date(),
        });
        console.log(`✅ All passengers notified — ride ${rideId} → driver_arrived`);
      }

      return;
    }

    // ── SPLIT RIDE — all passengers ───────────────────────────────────────────
    if (arriveAll) {
      const passengers = await Passenger.find({
        rideId,
        status: { $in: [PASSENGER_STATUS.matched, PASSENGER_STATUS.confirmed] },
        arrivedNotified: false, // শুধু unnotified দের
      });

      if (!passengers.length) {
        console.log(`⚠️ No unnotified passengers for ride ${rideId}`);
        return;
      }

      for (let i = 0; i < passengers.length; i++) {
        const isLast = i === passengers.length - 1;
        await notifyPassenger(passengers[i], isLast);
      }

      await Ride.findByIdAndUpdate(rideId, {
        status: RIDE_STATUS.driver_arrived,
        arrivedAt: new Date(),
      });

      console.log(`✅ All ${passengers.length} passengers notified for ride ${rideId}`);
    }
  },
);