// handlers/ride/rideCancelAfterAccept.handler.ts
import { getRedisClient } from '../../../config/redis.config';
import { RIDE_STATUS, CANCELLED_BY, RIDE_TYPE } from '../../../modules/ride/ride.constant';
import { BOOKING_STATUS, PAYMENT_STATUS } from '../../../modules/booking/booking.constant';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { User } from '../../../modules/user/user.model';
import { Refund } from '../../../modules/refund/refund.model';
import { Payment } from '../../../modules/payment/payment.model';
import { REFUND_STATUS, REFUND_TYPE } from '../../../modules/refund/refund.constant';
import { modeType } from '../../../modules/notification/notification.interface';
import { sendNotification } from '../../../utils/sentPushNotification';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import {
  calculateCancellationRefund,
  recalculateSplitFares,
  refundToWallet,
  transferRideOwnership,
} from '../../../utils/splitFare.utils';

// â”\u20ACâ”\u20AC Helper: notify driver (socket + FCM) â”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20AC
const notifyDriver = async (
  io:        any,
  driverId:  string,
  rideId:    string,
  message:   string,
  extra?:    Record<string, any>,
) => {
  // Socket
  io.to(`driver:${driverId}`).emit('ride:cancelled-by-rider', {
    rideId,
    message,
    ...extra,
  });

  // FCM push
  const driver = await User.findById(driverId).select('fcmToken').lean();
  if (driver?.fcmToken) {
    sendNotification([driver.fcmToken], {
      receiver:    driverId,
      message:     'Ride Cancelled by Rider',
      description: message,
      reference:   rideId,
      modelType:   modeType.Ride,
    }).catch(() => {});
  }
};

export const rideCancelAfterAcceptHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, reason = '' } = data;
    const userId = socket.auth?._id?.toString();

    if (!rideId || !userId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const io    = getIO();
    const redis = getRedisClient();

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });

    if (![RIDE_STATUS.accepted, RIDE_STATUS.started].includes(ride.status as any))
      return callback?.({ success: false, message: 'Cannot cancel at this stage' });

    // â”\u20ACâ”\u20AC Find passenger â”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20AC
    let passenger: any;

    if (ride.type === RIDE_TYPE.split) {
      if (!passengerId)
        return callback?.({ success: false, message: 'passengerId is required for split ride cancellation' });

      passenger = await Passenger.findOne({
        _id:    passengerId,
        rideId,
        userId,
        status: { $in: [PASSENGER_STATUS.confirmed, PASSENGER_STATUS.driver_arrived, PASSENGER_STATUS.pending] },
      });
    } else {
      passenger = await Passenger.findOne({
        rideId,
        userId,
        status: { $in: [PASSENGER_STATUS.confirmed, PASSENGER_STATUS.driver_arrived, PASSENGER_STATUS.pending] },
      });
    }

    if (!passenger)
      return callback?.({ success: false, message: 'No active booking found' });

    const booking    = await Booking.findOne({ passengerId: passenger._id }).lean();
    const paidAmount = booking?.amountPaid ?? passenger.estimatedFare ?? 0;

    // â”\u20ACâ”\u20AC Cancellation refund â”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20AC
    const departureDateTime = new Date(`${ride.departureDate}T${ride.departureTime}:00`);
    const { refundAmount, platformAmount, refundReason } = await calculateCancellationRefund(
      paidAmount,
      (passenger as any).createdAt || new Date(),
      departureDateTime,
    );

    // â”\u20ACâ”\u20AC Update passenger & booking â”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20AC
    await Passenger.findByIdAndUpdate(passenger._id, {
      status:             PASSENGER_STATUS.cancelled,
      cancellationReason: reason || 'Rider cancelled',
      cancelledBy:        CANCELLED_BY.user,
      refundAmount,
    });

    const bookingDoc = await Booking.findOne({ passengerId: passenger._id });
    if (bookingDoc) {
      bookingDoc.bookingStatus = BOOKING_STATUS.cancelled;
      bookingDoc.refundAmount = refundAmount;
      if (refundAmount > 0) {
        bookingDoc.paymentStatus = PAYMENT_STATUS.refunded as any;
      }
      await bookingDoc.save();
    }

    if (refundAmount > 0 && bookingDoc) {
      // 1. Find and update the payment record
      const payment = await Payment.findOne({ booking: bookingDoc._id, status: PAYMENT_STATUS.paid });
      if (payment) {
        payment.status = PAYMENT_STATUS.refunded as any;
        payment.isPaid = false;
        await payment.save();

        // 2. Revert the driver's wallet credit for the booking
        if (payment.providerEarning && payment.providerEarning > 0 && ride.driverId) {
          await User.findByIdAndUpdate(ride.driverId, {
            $inc: { wallet: -payment.providerEarning }
          });
          console.log(`ðŸ’° Deducted driver earning: Â\u20AC${payment.providerEarning} from driver: ${ride.driverId}`);
        }
      }

      // 3. Create Refund record
      await Refund.create({
        user: userId,
        ride: rideId,
        type: REFUND_TYPE.cancel_ride,
        paymentIntentId: bookingDoc.transactionId || payment?.transactionId || '',
        amount: refundAmount,
        reason: `Rider cancelled: ${reason || refundReason}`,
        note: `Ride ${rideId} cancelled by rider. Reason: ${refundReason}`,
        status: REFUND_STATUS.confirmed,
      });

      // 4. Refund to passenger's wallet
      await refundToWallet(userId, refundAmount, `cancel_${refundReason}`, io);
    }

    if (platformAmount > 0) {
      console.log(`ðŸ’¼ Platform revenue Â\u20AC${platformAmount} | ride ${rideId}`);
    }

    // â”\u20ACâ”\u20AC Decrement seats â”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20AC
    await Ride.findByIdAndUpdate(rideId, {
      $inc: {
        bookedSeats:      -(passenger.requestedSeats  || 1),
        malePassengers:   -(passenger.malePassengers  || 0),
        femalePassengers: -(passenger.femalePassengers || 0),
      },
    });
    if (ride.driverId) {
      await redis.hincrby(
        `driver:${ride.driverId}:details`,
        'bookedSeats',
        -(passenger.requestedSeats || 1),
      );
    }

    // â”\u20ACâ”\u20AC PRIVATE RIDE â”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20AC
    if (ride.type === RIDE_TYPE.private) {
      await Ride.findByIdAndUpdate(rideId, {
        status:             RIDE_STATUS.cancelled,
        cancellationReason: reason || 'Rider cancelled',
        cancelledBy:        CANCELLED_BY.user,
        cancelledAt:        new Date(),
      });

      await Promise.all([
        redis.del(`ride:active:${rideId}`),
        redis.zrem('ride:matching:queue', rideId),
        redis.del(`ride:request:${rideId}`),
      ]);

      // âœ… Notify driver â\u20AC” only ride:cancelled-by-rider
      if (ride.driverId) {
        await notifyDriver(
          io,
          ride.driverId.toString(),
          rideId,
          reason || 'Rider cancelled the ride.',
          { refundAmount },
        );
      }

      return callback?.({
        success: true,
        message: 'Ride cancelled.',
        data:    { refundAmount, refundReason, rideCancelled: true },
      });
    }

    // â”\u20ACâ”\u20AC SPLIT RIDE â”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20ACâ”\u20AC

    // Case 3: rideCreatedBy cancelled â†’ check if only 1 passenger remains
    if (ride.rideCreatedBy?.toString() === userId) {
      const remainingAfterCreator = await Passenger.countDocuments({
        rideId,
        _id: { $ne: passenger._id },
        status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
      });

      if (remainingAfterCreator <= 1) {
        await Ride.findByIdAndUpdate(rideId, {
          status: RIDE_STATUS.cancelled,
          cancellationReason: remainingAfterCreator === 0 ? 'Creator cancelled, no passengers remaining' : 'Creator cancelled, only one passenger remaining. Ride cancelled.',
          cancelledBy: CANCELLED_BY.user,
          cancelledAt: new Date(),
        });
        await Promise.all([
          redis.del(`ride:active:${rideId}`),
          redis.zrem('ride:matching:queue', rideId),
        ]);

        // âœ… Notify driver â\u20AC” only ride:cancelled-by-rider
        if (ride.driverId) {
          await notifyDriver(
            io,
            ride.driverId.toString(),
            rideId,
            remainingAfterCreator === 0 ? 'Ride creator cancelled. No passengers remaining.' : 'Ride creator cancelled. Only one passenger remaining. Ride cancelled.',
          );
        }

        return callback?.({
          success: true,
          message: 'Ride cancelled â\u20AC” only one passenger remaining.',
          data:    { refundAmount, refundReason, rideCancelled: true },
        });
      }

      const transferred = await transferRideOwnership(rideId, userId, io);
      if (!transferred) {
        await Ride.findByIdAndUpdate(rideId, {
          status:             RIDE_STATUS.cancelled,
          cancellationReason: 'Creator cancelled, no passengers remaining',
          cancelledBy:        CANCELLED_BY.user,
          cancelledAt:        new Date(),
        });
        await Promise.all([
          redis.del(`ride:active:${rideId}`),
          redis.zrem('ride:matching:queue', rideId),
        ]);

        // âœ… Notify driver â\u20AC” only ride:cancelled-by-rider
        if (ride.driverId) {
          await notifyDriver(
            io,
            ride.driverId.toString(),
            rideId,
            'Ride creator cancelled. No passengers remaining.',
          );
        }

        return callback?.({
          success: true,
          message: 'Ride cancelled â\u20AC” no other passengers.',
          data:    { refundAmount, refundReason, rideCancelled: true },
        });
      }
    }

    // Check remaining passengers
    const remainingCount = await Passenger.countDocuments({
      rideId,
      status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
    });

    if (remainingCount <= 1) {
      await Ride.findByIdAndUpdate(rideId, {
        status:             RIDE_STATUS.cancelled,
        cancellationReason: remainingCount === 0 ? 'Last passenger cancelled' : 'Only one passenger remaining. Ride cancelled.',
        cancelledBy:        CANCELLED_BY.user,
        cancelledAt:        new Date(),
      });
      await Promise.all([
        redis.del(`ride:active:${rideId}`),
        redis.zrem('ride:matching:queue', rideId),
      ]);

      // âœ… Notify driver â\u20AC” only ride:cancelled-by-rider
      if (ride.driverId) {
        await notifyDriver(
          io,
          ride.driverId.toString(),
          rideId,
          remainingCount === 0 ? 'All passengers cancelled. Ride is now cancelled.' : 'Only one passenger remaining. Ride cancelled.',
        );
      }

      return callback?.({
        success: true,
        message: 'Ride cancelled â\u20AC” only one passenger remaining.',
        data:    { refundAmount, refundReason, rideCancelled: true },
      });
    }

    // Remaining passengers exist â\u20AC” recalculate + notify driver only
    await recalculateSplitFares(rideId, 'passenger_cancelled', io);

    // âœ… Notify driver â\u20AC” only ride:cancelled-by-rider (not passenger-cancelled)
    if (ride.driverId) {
      await notifyDriver(
        io,
        ride.driverId.toString(),
        rideId,
        `A passenger cancelled. ${remainingCount} passenger(s) remaining.`,
        {
          passengerId:         passenger._id,
          remainingPassengers: remainingCount,
        },
      );
    }

    // âœ… Notify co-passengers â\u20AC” ride:co-passenger-cancelled (riders listen to this)
    const others = await Passenger.find({
      rideId,
      _id:    { $ne: passenger._id },
      status: { $nin: [PASSENGER_STATUS.cancelled, PASSENGER_STATUS.rejected] },
    }).select('userId fcmToken');

    for (const p of others) {
      io.to(`user:${p.userId}`).emit('ride:co-passenger-cancelled', {
        rideId,
        cancelledPassengerId: passenger._id,
        message:              'Another passenger cancelled their booking.',
      });

      // FCM to co-passengers
      const coUser = await User.findById(p.userId).select('fcmToken').lean();
      if (coUser?.fcmToken) {
        sendNotification([coUser.fcmToken], {
          receiver:    p.userId,
          message:     'Co-passenger Cancelled',
          description: 'Another passenger has cancelled. Your fare may be updated.',
          reference:   rideId,
          modelType:   modeType.Ride,
        }).catch(() => {});
      }
    }

    return callback?.({
      success: true,
      message: 'Booking cancelled.',
      data: {
        passengerId:         passenger._id,
        refundAmount,
        refundReason,
        rideCancelled:       false,
        remainingPassengers: remainingCount,
      },
    });
  },
);

