// handlers/ride/pickUpRideClean.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { Payment } from '../../../modules/payment/payment.model';
import { PAYMENT_STATUS } from '../../../modules/payment/payment.constant';
import { PaymentService } from '../../../modules/payment/payment.service';
import { User } from '../../../modules/user/user.model';
import { modeType } from '../../../modules/notification/notification.interface';
import { sendNotification } from '../../../utils/sentPushNotification';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import {
  isPassengerStartOtpVerified,
  sendRideStartOtp,
  verifyRideStartOtp,
} from '../../../utils/rideStartOtp.utils';

export const pickUpRideHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, otp } = data || {};
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId) {
      return callback?.({
        success: false,
        message: 'Missing required fields: rideId',
      });
    }

    const ride = await Ride.findById(rideId);
    if (!ride) {
      return callback?.({ success: false, message: 'Ride not found' });
    }

    if (ride.driverId?.toString() !== driverId) {
      return callback?.({
        success: false,
        message: 'You are not assigned to this ride',
      });
    }

    if (
      ride.status !== RIDE_STATUS.accepted &&
      ride.status !== RIDE_STATUS.started
    ) {
      return callback?.({
        success: false,
        message: `Cannot pick up passenger when ride status is ${ride.status}`,
      });
    }

    const io = getIO();
    const redis = getRedisClient();

    const passengerQuery: Record<string, any> = {
      rideId,
      status: {
        $in: [
          PASSENGER_STATUS.confirmed,
          PASSENGER_STATUS.driver_arrived,
          PASSENGER_STATUS.in_progress,
        ],
      },
    };
    if (passengerId) {
      passengerQuery._id = passengerId;
    }

    const passengers = await Passenger.find(passengerQuery);
    if (!passengers.length) {
      return callback?.({
        success: false,
        message: 'No active passenger found to pick up',
      });
    }

    // ── Verify OTP if provided in payload (SPLIT-051) ─────────────────────────
    if (otp) {
      try {
        await verifyRideStartOtp({
          rideId: String(rideId),
          passengerId: passengerId ? String(passengerId) : passengers[0]._id.toString(),
          otp,
          requesterId: driverId,
          requesterRole: 'provider',
        });
      } catch (otpErr: any) {
        return callback?.({
          success: false,
          requiresOtp: true,
          message:
            otpErr?.message ||
            'Invalid or expired ride start OTP. Please verify the passenger OTP.',
        });
      }
    }

    for (const passenger of passengers) {
      const verified = await isPassengerStartOtpVerified(
        String(rideId),
        passenger._id.toString(),
        passenger,
      );
      if (!verified) {
        try {
          await sendRideStartOtp({
            rideId: String(rideId),
            passengerId: passenger._id.toString(),
            requesterId: driverId,
            requesterRole: 'provider',
          });
        } catch {
          /* ignore send error */
        }

        return callback?.({
          success: false,
          requiresOtp: true,
          message:
            'Passenger OTP authorization is required before pickup. An OTP has been sent to the passenger via notification and email.',
          data: {
            rideId: ride._id,
            passengerId: passenger._id,
            requiresOtp: true,
          },
        });
      }
    }

    const now = new Date();
    if (ride.status === RIDE_STATUS.accepted) {
      ride.status = RIDE_STATUS.started as any;
      (ride as any).tripStartedAt = now;
      if (ride.type === RIDE_TYPE.split) {
        (ride as any).splitFareLocked = true;
        (ride as any).splitFareLockedAt = now;
      }
      await ride.save();

      if (ride.type === RIDE_TYPE.split) {
        const bookings = await Booking.find({
          rideId,
          bookingStatus: { $ne: BOOKING_STATUS.cancelled },
        });
        for (const b of bookings) {
          const payment = await Payment.findOne({ booking: b._id });
          if (payment && payment.status === PAYMENT_STATUS.authorized) {
            try {
              await PaymentService.captureAuthorizedBookingPayment(
                b._id.toString(),
                driverId,
                {
                  incrementRideSeats: false,
                  createChat: false,
                  recalculateSplit: false,
                  updateBookingStatus: false,
                }
              );
            } catch {
              /* ignore capture error */
            }
          }
        }
      }
    }

    for (const passenger of passengers) {
      const wasAlreadyPickedUp =
        passenger.status === PASSENGER_STATUS.picked_up;

      passenger.pickedUpAt = now;
      passenger.status = PASSENGER_STATUS.picked_up;

      if (passenger.arriveAt) {
        const delaySec = Math.max(
          0,
          Math.floor((now.getTime() - new Date(passenger.arriveAt).getTime()) / 1000),
        );
        passenger.pickupDelaySeconds = delaySec;
      }

      await passenger.save();

      await Booking.findOneAndUpdate(
        { passengerId: passenger._id, bookingStatus: { $ne: BOOKING_STATUS.cancelled } },
        { bookingStatus: BOOKING_STATUS.running },
      );

      await redis.rpush(
        `ride:${rideId}:live`,
        JSON.stringify({
          event: 'PASSENGER_PICKED_UP',
          driverId,
          passengerId: passenger._id,
          timestamp: now.getTime(),
        }),
      );

      io.to(`user:${passenger.userId}`).emit('ride:passenger-picked-up', {
        rideId,
        passengerId: passenger._id,
        driverId,
        pickedUpAt: now,
        message: 'You have been picked up. Your ride has started!',
      });

      io.to(`ride:${rideId}`).emit('ride:trip-started', {
        rideId,
        passengerId: passenger._id,
        driverId,
        startTime: now,
        message: 'Your ride has started. Enjoy the trip!',
      });

      if (!wasAlreadyPickedUp) {
        const riderUser = await User.findById(passenger.userId)
          .select('fcmToken')
          .lean();
        if (riderUser?.fcmToken) {
          sendNotification([riderUser.fcmToken], {
            receiver: passenger.userId,
            message: 'Trip Started!',
            description: 'Your ride has started. Enjoy the trip!',
            reference: String(rideId),
            modelType: modeType.Ride,
          }).catch(() => {});
        }
      }
    }

    return callback?.({
      success: true,
      message: 'Passenger picked up and ride started successfully',
      data: {
        rideId: ride._id,
        passengerIds: passengers.map((p) => p._id),
        pickedUpAt: now,
      },
    });
  },
);

