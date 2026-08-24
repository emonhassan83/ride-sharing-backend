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
import { Withdraw } from '../../../modules/withdraw/withdraw.model';
import { WITHDRAW_STATUS } from '../../../modules/withdraw/withdraw.constant';
import { User } from '../../../modules/user/user.model';
import { Setting } from '../../../modules/settings/settings.model';
import { saveLocationsToDatabase } from '../../../utils/location.db.utils';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { sendNotification } from '../../../utils/sentPushNotification';
import { modeType } from '../../../modules/notification/notification.interface';

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
      return callback?.({ success: false, message: `Cannot complete ‚\u20ACî status: ${ride.status}` });

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

    // ‚î\u20AC‚î\u20AC Determine which passengers to complete ‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC
    let passengers: any[];

    if (ride.type === RIDE_TYPE.private) {
      // ‚úÖ passengerId optional for private
      passengers = passengerId
        ? await Passenger.find({ _id: passengerId, rideId, status: { $in: [PASSENGER_STATUS.dropped_off, PASSENGER_STATUS.completed] } })
        : await Passenger.find({ rideId, status: { $in: [PASSENGER_STATUS.dropped_off, PASSENGER_STATUS.completed] } });
    } else {
      // ‚úÖ Split: passengerId optional ‚\u20ACî complete all dropped_off if not specified
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
      const totalFare = passenger.totalFare || (passenger.estimatedFare || 0) + (passenger.waitingCharge || 0);
      grandTotal += totalFare;

      await Passenger.findByIdAndUpdate(passenger._id, { status: PASSENGER_STATUS.completed });

      const booking = await Booking.findOneAndUpdate(
        { passengerId: passenger._id },
        { totalFare, amountPaid: totalFare, bookingStatus: BOOKING_STATUS.completed },
        { returnDocument: 'after' }
      );

      if (booking) {
        const payment = await Payment.findOne({
          booking: booking._id,
          provider: driverId,
          status: PAYMENT_STATUS.paid,
          isPaid: true,
        });

        if (ride.type !== RIDE_TYPE.split && payment && (payment.providerEarning || 0) > 0) {
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

      const riderUser = await User.findById(passenger.userId).select('fcmToken').lean();
      if (riderUser?.fcmToken) {
        sendNotification([riderUser.fcmToken], {
          receiver: passenger.userId, message: 'Trip Completed!',
          description: `Total fare: ¬\u20AC${totalFare}. Thank you for riding with us!`,
          reference: rideId, modelType: modeType.Ride,
        }).catch(() => { });
      }

      io.to(`user:${passenger.userId}`).emit('ride:trip-completed', {
        rideId, passengerId: passenger._id, totalFare,
        message: 'Trip completed successfully. Thank you!',
      });

      io.to(`user:${passenger.userId}`).emit('ride:request-rating', { rideId, driverId });
    }

    // ‚î\u20AC‚î\u20AC Check if all passengers done (for split ride partial complete) ‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC‚î\u20AC
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

        const creatorPassenger = await Passenger.findOne({
          rideId,
          userId: ride.rideCreatedBy,
        }).select('_id').lean();
        const creatorBooking = creatorPassenger
          ? await Booking.findOne({ rideId, passengerId: creatorPassenger._id }).select('_id').lean()
          : null;
        const creatorPayment = creatorBooking
          ? paidPayments.find((payment: any) => payment.booking?.toString() === creatorBooking._id.toString())
          : null;
        const maxPaidReferenceAmount = Math.max(
          0,
          ...paidPayments.map((payment: any) => Number(
            payment.authorizedAmount || payment.amount || payment.amountToCapture || 0,
          )),
        );
        const totalCollectedAmount = Math.round(
          Number(
            creatorPayment?.authorizedAmount ||
            creatorPayment?.amount ||
            creatorPayment?.amountToCapture ||
            maxPaidReferenceAmount ||
            0,
          ) * 100,
        ) / 100;
        const [commissionSetting, vatSetting] = await Promise.all([
          Setting.findOne({ key: 'platformCommissionPercent' }).lean(),
          Setting.findOne({ key: 'platformVat' }).lean(),
        ]);
        const commissionPercent = Math.max(Number(commissionSetting?.value ?? 0), 0);
        const vatPercent = Math.max(Number(vatSetting?.value ?? 0), 0);
        const driverEarningAmount = Math.max(
          Math.round((totalCollectedAmount / (1 + (commissionPercent + vatPercent) / 100)) * 100) / 100,
          0,
        );
        const platformCommissionAmount = Math.round(
          driverEarningAmount * (commissionPercent / 100) * 100,
        ) / 100;

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
          },
          { returnDocument: 'after' },
        );

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
        const [commissionSetting, vatSetting] = await Promise.all([
          Setting.findOne({ key: 'platformCommissionPercent' }).lean(),
          Setting.findOne({ key: 'platformVat' }).lean(),
        ]);
        const commissionPercent = Math.max(Number(commissionSetting?.value ?? 0), 0);
        const vatPercent = Math.max(Number(vatSetting?.value ?? 0), 0);
        const driverEarningAmount = Math.max(
          Math.round((totalCollectedAmount / (1 + (commissionPercent + vatPercent) / 100)) * 100) / 100,
          0,
        );
        const platformCommissionAmount = Math.round(
          driverEarningAmount * (commissionPercent / 100) * 100,
        ) / 100;

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

      try { await saveLocationsToDatabase(rideId, parsedLocations, driverId); } catch (err) {
        console.error(`‚ùå Location history save failed:`, err);
      }

      await Promise.all([
        redis.del(locationKey),
        redis.del(`ride:active:${rideId}`),
        redis.del(`driver:${driverId}:activeRide`),
      ]);

      io.to(`driver:${driverId}`).emit('ride:trip-completed', {
        rideId, totalFare: grandTotal, message: 'Ride completed successfully!',
      });
    }

    return callback?.({
      success: true,
      message: allComplete ? 'Ride completed successfully' : 'Passenger(s) completed. Ride still in progress.',
      data: { rideId, totalFare: grandTotal, passengerCount: passengersToComplete.length, allComplete },
    });
  },
);











