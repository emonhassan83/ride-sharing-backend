// handlers/driver/driverCompleteTrip.handler.ts
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
import { Withdraw } from '../../../modules/withdraw/withdraw.model';
import { WITHDRAW_STATUS } from '../../../modules/withdraw/withdraw.constant';
import { User } from '../../../modules/user/user.model';
import { loadFareSettings } from '../../../utils/fareCalculator';
import { computeDriverPayoutFromPassengerTotal, roundMoney } from '../../../utils/fareMath.utils';
import { saveLocationsToDatabase } from '../../../utils/location.db.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { notifyUserPush } from '../../../utils/notifyUser.utils';
import { modeType } from '../../../modules/notification/notification.interface';

const resolveDriverPayout = async (
  totalCollectedAmount: number,
  rideType: 'private' | 'split',
  isMatchedSplit: boolean,
) => {
  const settings = await loadFareSettings();
  const payout = computeDriverPayoutFromPassengerTotal(
    totalCollectedAmount,
    rideType,
    settings,
    isMatchedSplit,
  );

  return {
    driverEarningAmount: payout.driverEarningAmount,
    platformCommissionAmount: roundMoney(
      payout.driverPlatformFeeAmount + payout.driverVatAmount,
    ),
    driverGrossAmount: payout.komistraGross,
    driverPlatformFeeAmount: payout.driverPlatformFeeAmount,
    driverVatAmount: payout.driverVatAmount,
  };
};

/**
 * B-06: split the ride-level payout across the ride's payments in proportion
 * to what each rider paid. The last payment takes the rounding remainder, so
 * the per-payment sums equal the ride totals exactly.
 */
const distributeSplitPayoutToPayments = async (
  paymentIds: any[],
  totalCollectedAmount: number,
  driverEarningAmount: number,
  platformCommissionAmount: number,
) => {
  if (!paymentIds.length || totalCollectedAmount <= 0) return;
  const payments = await Payment.find({ _id: { $in: paymentIds } });
  let earningLeft = roundMoney(driverEarningAmount);
  let commissionLeft = roundMoney(platformCommissionAmount);
  for (let i = 0; i < payments.length; i++) {
    const payment: any = payments[i];
    const isLast = i === payments.length - 1;
    const paid = Number(payment.amount || payment.amountToCapture || payment.authorizedAmount || 0);
    const share = paid / totalCollectedAmount;
    const earning = isLast ? earningLeft : roundMoney(driverEarningAmount * share);
    const commission = isLast ? commissionLeft : roundMoney(platformCommissionAmount * share);
    earningLeft = roundMoney(earningLeft - earning);
    commissionLeft = roundMoney(commissionLeft - commission);
    payment.providerEarning = earning;
    payment.platformCommission = commission;
    await payment.save();
  }
};

export const driverCompleteTripHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId } = data;
    const driverId = socket.auth?._id?.toString();

    if (!driverId || !rideId)
      return callback?.({ success: false, message: 'Missing required fields' });

    const redis = getRedisClient();
    const io = getIO();

    const ride = await Ride.findById(rideId);
    if (!ride)
      return callback?.({ success: false, message: 'Ride not found' });
    if (ride.driverId?.toString() !== driverId)
      return callback?.({ success: false, message: 'You are not assigned to this ride' });
    if (ride.status !== RIDE_STATUS.started)
      return callback?.({ success: false, message: `Cannot complete - status: ${ride.status}` });

    const locationKey = `ride:${rideId}:live`;
    const locations = await redis.lrange(locationKey, 0, -1);
    const parsedLocations = locations.map((loc: string) => JSON.parse(loc));

    const activeTripPassengerStatuses = [
      PASSENGER_STATUS.confirmed,
      PASSENGER_STATUS.driver_arrived,
      PASSENGER_STATUS.in_progress,
      PASSENGER_STATUS.picked_up,
      PASSENGER_STATUS.dropped_off,
    ];

    // ── Determine which passengers to complete ──
    let passengers: any[];

    if (ride.type === RIDE_TYPE.private) {
      // ✅ passengerId optional for private
      passengers = passengerId
        ? await Passenger.find({ _id: passengerId, rideId, status: { $in: [PASSENGER_STATUS.dropped_off, PASSENGER_STATUS.completed] } })
        : await Passenger.find({ rideId, status: { $in: [PASSENGER_STATUS.dropped_off, PASSENGER_STATUS.completed] } });
    } else {
      // ✅ Split: passengerId optional - complete all dropped_off if not specified
      passengers = passengerId
        ? await Passenger.find({ _id: passengerId, rideId, status: { $in: [PASSENGER_STATUS.dropped_off, PASSENGER_STATUS.completed] } })
        : await Passenger.find({ rideId, status: { $in: [PASSENGER_STATUS.dropped_off, PASSENGER_STATUS.completed] } });
    }

    if (!passengers.length)
      return callback?.({ success: false, message: 'No dropped off passengers to complete' });

    const passengersToComplete = passengers.filter(
      (passenger) => passenger.status !== PASSENGER_STATUS.completed,
    );

    let grandTotal = 0;

    for (const passenger of passengersToComplete) {
      const totalFare = passenger.estimatedFare || passenger.totalFare || 0;
      grandTotal += totalFare;

      // Atomic: a double tap used to complete (capture, notify) the passenger twice (issue 9).
      const transitioned = await Passenger.findOneAndUpdate(
        { _id: passenger._id, status: { $ne: PASSENGER_STATUS.completed } },
        { $set: { status: PASSENGER_STATUS.completed } },
        { returnDocument: 'after' },
      );
      if (!transitioned) {
        grandTotal -= totalFare;
        continue;
      }

      const booking = await Booking.findOneAndUpdate(
        {
          passengerId: passenger._id,
          bookingStatus: { $ne: BOOKING_STATUS.cancelled },
          // Issue 14: never overwrite a refunded/released booking with amountPaid = fare.
          paymentStatus: { $nin: [PAYMENT_STATUS.refunded, PAYMENT_STATUS.cancelled_authorization] },
        },
        { totalFare, amountPaid: totalFare, bookingStatus: BOOKING_STATUS.completed },
        { returnDocument: 'after' }
      );

      if (booking) {
        let payment = await Payment.findOne({
          booking: booking._id,
        });

        if (payment && payment.status === PAYMENT_STATUS.authorized) {
          try {
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
          } catch {
            /* ignore capture error */
          }
          payment = await Payment.findOne({
            booking: booking._id,
          });
        }

        if (ride.type !== RIDE_TYPE.split && payment && payment.status === PAYMENT_STATUS.paid && (payment.providerEarning || 0) > 0) {
          await Withdraw.findOneAndUpdate(
            { payment: payment._id },
            {
              $setOnInsert: {
                user: driverId,
                ride: ride._id,
                booking: booking._id,
                payment: payment._id,
                amount: Math.round((payment.providerEarning || 0) * 100) / 100,
                status: WITHDRAW_STATUS.pending,
                note: `Auto-created from completed ride ${booking.id}`,
              },
            },
            { upsert: true, returnDocument: 'after' }
          );
        }
      }

      // Same dedupe key as the drop-off push: one "trip finished" push per rider.
      notifyUserPush({
        userId: passenger.userId.toString(),
        message: 'Trip Completed!',
        description: `Total fare: €${totalFare}. Thank you for riding with us!`,
        reference: String(rideId),
        modelType: modeType.Ride,
        dedupeKey: `trip-finished:${passenger._id.toString()}`,
        data: {
          type: 'TRIP_COMPLETED',
          rideId: String(rideId),
          passengerId: passenger._id.toString(),
          totalFare: String(totalFare),
        },
      }).catch(() => {});

      io.to(`user:${passenger.userId}`).emit('ride:trip-completed', {
        rideId, passengerId: passenger._id, totalFare,
        message: 'Trip completed successfully. Thank you!',
      });

      io.to(`user:${passenger.userId}`).emit('ride:request-rating', { rideId, driverId });
    }

    // ── Check if all passengers done (for split ride partial complete) ──
    const remainingActiveTripPassengers = await Passenger.countDocuments({
      rideId,
      status: { $in: activeTripPassengerStatuses },
    });

    const allComplete = remainingActiveTripPassengers === 0;

    if (allComplete) {
      const completedAt = new Date();

      if (ride.type === RIDE_TYPE.split) {
        const completedBookings = await Booking.find({
          rideId,
          bookingStatus: BOOKING_STATUS.completed,
          paymentStatus: PAYMENT_STATUS.paid,
        }).select('_id id').lean();
        const bookingIds = completedBookings.map((booking: any) => booking._id);

        const paidPayments = await Payment.find({
          booking: { $in: bookingIds },
          provider: driverId,
          status: PAYMENT_STATUS.paid,
          isPaid: true,
        }).select('booking amount amountToCapture authorizedAmount').lean();

        const totalCollectedAmount = Math.round(
          paidPayments.reduce(
            (sum: number, payment: any) =>
              sum +
              Number(
                payment.amount || payment.amountToCapture || payment.authorizedAmount || 0,
              ),
            0,
          ) * 100,
        ) / 100;
        const isMatchedSplit =
          Number((ride as any).currentSurchargePercent || 0) > 0 ||
          paidPayments.length >= 2;
        const {
          driverEarningAmount,
          platformCommissionAmount,
          driverGrossAmount,
          driverPlatformFeeAmount,
          driverVatAmount,
        } = await resolveDriverPayout(
          totalCollectedAmount,
          'split',
          isMatchedSplit,
        );

        const creditedRide = await Ride.findOneAndUpdate(
          { _id: rideId, driverEarningCredited: { $ne: true } },
          {
            status: RIDE_STATUS.completed,
            completedAt,
            driverEarningCredited: true,
            driverEarningCreditedAt: completedAt,
            driverEarningAmount,
            platformCommissionAmount,
            totalCollectedAmount,
            driverGrossAmount,
            driverPlatformFeeAmount,
            driverVatAmount,
          },
          { returnDocument: 'after' },
        );

        // B-06: split payments kept the per-rider estimate from authorization
        // (often priced as an unmatched rider), so the per-payment numbers the
        // app summed (€25.02) disagreed with what was actually credited
        // (€21.18). Write the ride-level payout back pro rata to each payment.
        if (creditedRide) {
          await distributeSplitPayoutToPayments(
            paidPayments.map((p: any) => p._id),
            totalCollectedAmount,
            driverEarningAmount,
            platformCommissionAmount,
          );
        }

        if (creditedRide && driverEarningAmount > 0) {
          await User.findByIdAndUpdate(driverId, { $inc: { wallet: driverEarningAmount } });
          await Withdraw.findOneAndUpdate(
            { user: driverId, ride: ride._id },
            {
              $setOnInsert: {
                user: driverId,
                ride: ride._id,
                booking: completedBookings[0]?._id || null,
                payment: null,
                amount: driverEarningAmount,
                status: WITHDRAW_STATUS.pending,
                note: `Auto-created from completed split ride ${ride.id}`,
              },
            },
            { upsert: true, returnDocument: 'after' },
          );
        }
      } else {
        const completedBookings = await Booking.find({
          rideId,
          bookingStatus: BOOKING_STATUS.completed,
          paymentStatus: PAYMENT_STATUS.paid,
        }).select('_id id').lean();
        const bookingIds = completedBookings.map((booking: any) => booking._id);

        const paidPayments = await Payment.find({
          booking: { $in: bookingIds },
          provider: driverId,
          status: PAYMENT_STATUS.paid,
          isPaid: true,
        });

        const totalCollectedAmount = Math.round(
          paidPayments.reduce(
            (sum: number, payment: any) => sum + Number(payment.amount || payment.amountToCapture || 0),
            0,
          ) * 100,
        ) / 100;
        const {
          driverEarningAmount,
          platformCommissionAmount,
          driverGrossAmount,
          driverPlatformFeeAmount,
          driverVatAmount,
        } = await resolveDriverPayout(totalCollectedAmount, 'private', false);

        const creditedRide = await Ride.findOneAndUpdate(
          { _id: rideId, driverEarningCredited: { $ne: true } },
          {
            status: RIDE_STATUS.completed,
            completedAt,
            driverEarningCredited: true,
            driverEarningCreditedAt: completedAt,
            driverEarningAmount,
            platformCommissionAmount,
            totalCollectedAmount,
            driverGrossAmount,
            driverPlatformFeeAmount,
            driverVatAmount,
          },
          { returnDocument: 'after' },
        );

        if (creditedRide && driverEarningAmount > 0) {
          await Promise.all(
            paidPayments.map((payment: any) => {
              payment.providerEarning = driverEarningAmount;
              payment.platformCommission = platformCommissionAmount;
              return payment.save();
            }),
          );
          await User.findByIdAndUpdate(driverId, { $inc: { wallet: driverEarningAmount } });
          await Withdraw.findOneAndUpdate(
            { user: driverId, payment: paidPayments[0]?._id },
            {
              user: driverId,
              ride: ride._id,
              booking: completedBookings[0]?._id || null,
              payment: paidPayments[0]?._id || null,
              amount: driverEarningAmount,
              status: WITHDRAW_STATUS.pending,
              note: `Auto-created from completed ride ${completedBookings[0]?.id || ride.id}`,
            },
            { upsert: true, returnDocument: 'after' },
          );
        }
      }


      await Promise.all([
        redis.del(`ride:active:${rideId}`),
        redis.del(`driver:${driverId}:activeRide`),
      ]);

      io.to(`driver:${driverId}`).emit('ride:trip-completed', {
        rideId, totalFare: grandTotal, message: 'Ride completed successfully!',
      });
    }

    callback?.({
      success: true,
      message: allComplete ? 'Ride completed successfully' : 'Passenger(s) completed. Ride still in progress.',
      data: { rideId, totalFare: grandTotal, passengerCount: passengersToComplete.length, allComplete },
    });

    // Housekeeping after the ack: the location history is not needed to answer
    // the driver. The live list is deleted only once it has been saved.
    if (allComplete) {
      saveLocationsToDatabase(rideId, parsedLocations, driverId)
        .catch((err) => console.error('Location history save failed:', err))
        .finally(() => redis.del(locationKey).catch(() => {}));
    }
  },
);











