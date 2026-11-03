// jobs/noShowPassengers.job.ts
import { getRedisClient } from '../config/redis.config';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { Passenger } from '../modules/passenger/passenger.model';
import { Ride } from '../modules/ride/ride.model';
import { RIDE_STATUS } from '../modules/ride/ride.constant';
import { Setting } from '../modules/settings/settings.model';
import { getIO } from '../socket/socket.init';
import { recalculateSplitFares } from '../utils/splitFare.utils';
import { notifyUserPush } from '../utils/notifyUser.utils';
import { modeType } from '../modules/notification/notification.interface';
import { Booking } from '../modules/booking/booking.model';
import { PaymentService } from '../modules/payment/payment.service';

const BATCH_SIZE = 50;

export const checkNoShowPassengers = async (): Promise<void> => {
  try {
    const io = getIO();
    const setting = await Setting.findOne({ key: 'waitingTimeMinutes' }).lean();
    const waitMin = Number(setting?.value ?? 60);
    const cutoff = new Date(Date.now() - waitMin * 60 * 1000);

    const noShows = await Passenger.find({
      status: PASSENGER_STATUS.driver_arrived,
      rideId: { $ne: null },
      arriveAt: { $lte: cutoff },
      isNoShow: { $ne: true },
      pickedUpAt: null,
    })
      .limit(BATCH_SIZE)
      .lean();

    if (!noShows.length) return;

    for (const passenger of noShows) {
      if (!passenger.rideId) continue;
      // ── Mark as No-Show ─────────────────────────────────────────────
      await Passenger.findByIdAndUpdate(passenger._id, {
        status: PASSENGER_STATUS.cancelled,
        isNoShow: true,
        cancellationReason: 'no_show',
        cancelledBy: 'system',
      });

      // ── Get Ride & Driver Info ──────────────────────────────────────
      const booking = await Booking.findOne({ passengerId: passenger._id });
      if (booking) {
        await PaymentService.cancelAuthorizedBookingPayment(booking._id.toString());
      }

      const ride = await Ride.findById(passenger.rideId)
        .select('driverId rideCreatedBy type')
        .lean();

      if (!ride) continue;

      const riderId = passenger.userId?.toString();
      const rideIdStr = passenger.rideId.toString();

      // Real-time + push to rider
      if (riderId) {
        io.to(`user:${riderId}`).emit('ride:no-show', {
          rideId: passenger.rideId,
          passengerId: passenger._id,
          message: 'You were marked as no-show. No refund will be issued.',
        });

        await notifyUserPush({
          userId: riderId,
          message: 'You were marked as No-Show',
          description:
            'You did not show up at the pickup location. No refund will be issued for this ride.',
          reference: rideIdStr,
          modelType: modeType.Ride,
          data: {
            type: 'PASSENGER_NO_SHOW',
            rideId: rideIdStr,
            passengerId: String(passenger._id),
          },
        });
      }

      // Real-time + push to driver
      if (ride.driverId) {
        const driverId = ride.driverId.toString();
        io.to(`driver:${driverId}`).emit('ride:passenger-no-show', {
          rideId: passenger.rideId,
          passengerId: passenger._id,
          message: 'Passenger no-show. You may proceed.',
        });

        await notifyUserPush({
          userId: driverId,
          message: 'Passenger No-Show',
          description:
            'One passenger did not show up. You may proceed with the ride.',
          reference: rideIdStr,
          modelType: modeType.Ride,
          data: {
            type: 'PASSENGER_NO_SHOW',
            rideId: rideIdStr,
            passengerId: String(passenger._id),
          },
        });
      }

      // ── Update Ride Seats ───────────────────────────────────────────
      await Ride.findByIdAndUpdate(passenger.rideId, {
        $inc: { bookedSeats: -(passenger.requestedSeats || 1) },
      });

      // ── Recalculate fares for Split Ride ────────────────────────────
      if (ride.type === 'split') {
        await recalculateSplitFares(
          passenger.rideId.toString(),
          'passenger_cancelled',
          io
        );
      }

      // ── Cancel ride if no passengers left ───────────────────────────
      const remaining = await Passenger.countDocuments({
        rideId: passenger.rideId,
        status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
      });

      if (remaining <= 1) {
        const isLast = remaining === 0;
        await Ride.findByIdAndUpdate(passenger.rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: isLast ? 'all_passengers_no_show' : 'Only one passenger remaining. Ride cancelled.',
        });

        const redis = getRedisClient();
        await Promise.all([
          redis.del(`ride:active:${passenger.rideId}`),
          redis.zrem('ride:matching:queue', passenger.rideId.toString()),
          redis.del(`ride:request:${passenger.rideId}`),
        ]);

        if (ride.driverId) {
          const driverId = ride.driverId.toString();
          const cancelMsg = isLast
            ? 'All passengers no-show. Ride cancelled.'
            : 'Only one passenger remaining. Ride cancelled.';

          io.to(`driver:${driverId}`).emit('ride:cancelled', {
            rideId: passenger.rideId,
            message: cancelMsg,
          });

          await notifyUserPush({
            userId: driverId,
            message: 'Ride Cancelled',
            description: cancelMsg,
            reference: rideIdStr,
            modelType: modeType.Ride,
            data: {
              type: 'RIDE_CANCELLED_NO_SHOW',
              rideId: rideIdStr,
            },
          });
        }
      }

      console.log(`🚫 No-show processed: passenger ${passenger._id}`);
    }
  } catch (error) {
    console.error('❌ checkNoShowPassengers error:', error);
  }
};

