// handlers/driver/driverStartTrip.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { User } from '../../../modules/user/user.model';
import { modeType } from '../../../modules/notification/notification.interface';
import { sendNotification } from '../../../utils/sentPushNotification';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

export const driverStartTripHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const ride = await Ride.findById(rideId);
    if (!ride) return callback?.({ success: false, message: 'Ride not found' });

    if (ride.driverId?.toString() !== driverId)
      return callback?.({
        success: false,
        message: 'You are not assigned to this ride',
      });

    if (ride.status !== RIDE_STATUS.accepted)
      return callback?.({
        success: false,
        message: `Ride cannot be started. Current status: ${ride.status}`,
      });

    const io = getIO();
    const redis = getRedisClient();

    socket.join(`ride:${rideId}`);

    const passengers = await Passenger.find({
      rideId,
      status: PASSENGER_STATUS.confirmed,
    });

    if (!passengers.length)
      return callback?.({
        success: false,
        message: 'No confirmed passengers found',
      });

    // ── Update ride → started ─────────────────────────────────────────────────
    await Ride.findByIdAndUpdate(rideId, {
      status: RIDE_STATUS.started,
      tripStartedAt: new Date(),
    });

    // ── Update passengers + bookings ──────────────────────────────────────────
    for (const passenger of passengers) {
      passenger.status = PASSENGER_STATUS.in_progress;
      await passenger.save();

      await Booking.findOneAndUpdate(
        { passengerId: passenger._id },
        { bookingStatus: BOOKING_STATUS.running }
      );

      // Socket
      io.to(`ride:${rideId}`).emit('ride:trip-started', {
        rideId,
        passengerId: passenger._id,
        driverId,
        startTime: new Date(),
        message: 'Your ride has started. Enjoy the trip!',
      });

      // ✅ FCM push — trip started
      const riderUser = await User.findById(passenger.userId)
        .select('fcmToken')
        .lean();
      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver: passenger.userId,
          message: 'Trip Started!',
          description: 'Your ride has started. Enjoy the trip!',
          reference: rideId,
          modelType: modeType.Ride,
        }).catch(() => {});
      }

      console.log(`✅ Passenger ${passenger._id} → in_progress | FCM sent`);
    }

    // ── Redis ─────────────────────────────────────────────────────────────────
    await redis.rpush(
      `ride:${rideId}:live`,
      JSON.stringify({
        event: 'TRIP_STARTED',
        driverId,
        passengerCount: passengers.length,
        passengerIds: passengers.map((p) => p._id),
        timestamp: Date.now(),
      })
    );
    await redis.set(`driver:${driverId}:activeRide`, rideId, 'EX', 7200);

    console.log(
      `✅ Trip started | rideId: ${rideId} | passengers: ${passengers.length}`
    );

    return callback?.({
      success: true,
      message: 'Trip started successfully',
      data: { rideId: ride._id, passengerCount: passengers.length },
    });
  }
);
