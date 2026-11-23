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
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { lockSplitRideFare } from '../../../utils/splitFare.utils';
import { notifyUserPush } from '../../../utils/notifyUser.utils';
import { modeType } from '../../../modules/notification/notification.interface';

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
      status: {
        $in: [PASSENGER_STATUS.confirmed, PASSENGER_STATUS.driver_arrived],
      },
    });

    if (!passengers.length)
      return callback?.({
        success: false,
        message: 'No confirmed passengers found',
      });

    if (ride.type === RIDE_TYPE.split) {
      await lockSplitRideFare(rideId, 'trip_start', io);

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

    // Update ride -> started. Atomic: a double tap / concurrent retry used to run
    // the whole start (and send every notification) twice (issue 9).
    const startedRide = await Ride.findOneAndUpdate(
      { _id: rideId, status: RIDE_STATUS.accepted },
      { $set: { status: RIDE_STATUS.started, tripStartedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!startedRide) {
      return callback?.({
        success: true,
        message: 'Trip already started',
        data: { rideId, alreadyStarted: true },
      });
    }

    // ── Update passengers + bookings ──────────────────────────────────────────
    for (const passenger of passengers) {
      if (passenger.status === PASSENGER_STATUS.confirmed) {
        passenger.status = PASSENGER_STATUS.in_progress;
        await passenger.save();
      }

      await Booking.findOneAndUpdate(
        { passengerId: passenger._id },
        { bookingStatus: BOOKING_STATUS.running }
      );

      const tripMessage =
        'Driver has started the trip and is heading to the pickup location.';

      // Socket: ONE emit to both rooms. Two separate emits delivered the event
      // twice to the rider, whose socket is in both `ride:` and `user:` rooms.
      const riderId = passenger.userId?.toString();
      const tripStartedRooms = riderId
        ? [`ride:${rideId}`, `user:${riderId}`]
        : [`ride:${rideId}`];
      io.to(tripStartedRooms).emit('ride:trip-started', {
        rideId,
        passengerId: passenger._id,
        driverId,
        startTime: new Date(),
        message: tripMessage,
      });

      if (riderId) {
        // "Driver On The Way": the driver has only STARTED towards the pickup.
        // The pickup handler sends "Trip Started!" when the rider is on board,
        // so the two pushes no longer look like the same notification twice.
        await notifyUserPush({
          userId: riderId,
          message: 'Driver On The Way',
          description: tripMessage,
          reference: rideId,
          modelType: modeType.Ride,
          dedupeKey: `trip-started:${passenger._id.toString()}`,
          data: {
            type: 'TRIP_STARTED',
            rideId: String(rideId),
            passengerId: String(passenger._id),
          },
        });
      }

      console.log(`✅ Passenger ${passenger._id} → in_progress`);
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
