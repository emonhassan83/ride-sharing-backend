// handlers/driver/driverStartTrip.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { Payment } from '../../../modules/payment/payment.model';
import { PAYMENT_STATUS as PAYMENT_RECORD_STATUS } from '../../../modules/payment/payment.constant';
import { PaymentService } from '../../../modules/payment/payment.service';
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

    if (ride.type === RIDE_TYPE.split) {
      const passengerIds = passengers.map((passenger) => passenger._id);
      const bookings = await Booking.find({
        rideId,
        passengerId: { $in: passengerIds },
      });

      if (bookings.length !== passengers.length) {
        return callback?.({
          success: false,
          message: 'All split ride passengers must have bookings before trip start',
        });
      }

      for (const booking of bookings) {
        const payment = await Payment.findOne({ booking: booking._id });

        if (!payment) {
          return callback?.({
            success: false,
            message: 'All split ride passengers must complete payment authorization before trip start',
          });
        }

        if (payment.status === PAYMENT_RECORD_STATUS.requires_reauthorization) {
          return callback?.({
            success: false,
            message: 'One or more passengers must re-authorize payment before trip start',
            data: { bookingId: booking._id, paymentStatus: payment.status },
          });
        }

        if (payment.status === PAYMENT_RECORD_STATUS.authorized) {
          await PaymentService.captureAuthorizedBookingPayment(
            booking._id.toString(),
            driverId,
            {
              incrementRideSeats: false,
              createChat: false,
              recalculateSplit: false,
              updateBookingStatus: false,
            }
          );
          continue;
        }

        if (payment.status !== PAYMENT_RECORD_STATUS.paid) {
          return callback?.({
            success: false,
            message: 'All split ride payments must be authorized before trip start',
            data: { bookingId: booking._id, paymentStatus: payment.status },
          });
        }
      }
    }

    // Update ride -> started
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
