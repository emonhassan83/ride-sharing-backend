import Stripe from 'stripe';
import httpStatus from 'http-status';
import QueryBuilder from '../../builder/QueryBuilder';
import { Payment } from './payment.model';
import mongoose, { startSession } from 'mongoose';
import { PAYMENT_METHOD, PAYMENT_STATUS } from './payment.constant';
import { BOOKING_STATUS } from '../booking/booking.constant';
import { User } from '../user/user.model';
import { Chat } from '../chat/chat.models';
import { CHAT_STATUS } from '../chat/chat.constants';
import ApiError from '../../errors/ApiError';
import { config } from '../../config/env.config';
import { Booking } from '../booking/booking.model';
import { generateTransactionId } from '../../utils/generateTransctionId';
import { paymentNotifyToUser } from './payment.utils';
import { StatusCodes } from 'http-status-codes';
import { Passenger } from '../passenger/passenger.model';
import { PASSENGER_STATUS } from '../passenger/passenger.constant';
import { Ride } from '../ride/ride.model';
import { RIDE_TYPE } from '../ride/ride.constant';
import { getIO } from '../../socket/socket.init';
import { notifyNearbyDrivers, notifyNearbyDriversForSplitRide } from '../../utils/notifyDrivers.utils';
import { sendNotification } from '../../utils/sentPushNotification';
import { modeType } from '../notification/notification.interface';
import { getRedisClient } from '../../config/redis.config';
import { recalculateSplitFares } from '../../utils/splitFare.utils';
import { assertMinimumBookingLeadTime, getDepartureDateTime } from '../../utils/rideSchedule.utils';
import { loadFareSettings } from '../../utils/fareCalculator';
import {
  computeDriverPayoutFromPassengerTotal,
  roundMoney,
} from '../../utils/fareMath.utils';

const stripe = new Stripe(config.pay?.secretKey as string, {
  apiVersion: '2026-06-24.dahlia',
  typescript: true,
});
const isBookingPaymentReadyForMatching = (status: any): boolean =>
  [PAYMENT_STATUS.authorized, PAYMENT_STATUS.paid].includes(status);

const startRideMatchingAfterPayment = async (bookingId: string): Promise<number> => {
  const booking = await Booking.findById(bookingId).lean();
  if (!booking || !isBookingPaymentReadyForMatching((booking as any).paymentStatus)) return 0;

  const passenger = await Passenger.findById(booking.passengerId).lean();
  if (!passenger) return 0;

  if (passenger.status === PASSENGER_STATUS.split_matching || !booking.rideId) {
    const redis = getRedisClient();
    await redis.hset(`split:matching:passenger:${passenger._id}`, {
      bookingId: booking._id.toString(),
      passengerId: passenger._id.toString(),
      userId: booking.userId.toString(),
      matchingStatus: 'split_matching_authorized',
      lastCheckedAt: Date.now().toString(),
    });
    return 0;
  }

  if (passenger.status !== PASSENGER_STATUS.pending) return 0;

  const ride = await Ride.findById(booking.rideId).lean();
  if (!ride) return 0;

  const rider = await User.findById(booking.userId)
    .select('_id name profileImage')
    .lean();

  const redis = getRedisClient();
  const io = getIO();
  const ridePayload: any = {
    _id: passenger._id,
    userId: {
      _id: rider?._id || null,
      name: rider?.name || '',
      profileImage: rider?.profileImage || null,
    },
    rideId: {
      _id: ride._id,
      type: ride.type,
      id: (ride as any).id || '',
    },
    bookingId: booking._id.toString(),
    pickup: {
      address: (passenger as any).pickup?.address || (ride as any).pickup?.address,
      coordinates: (passenger as any).pickup?.coordinates || (ride as any).pickup?.coordinates,
    },
    destination: {
      address: (passenger as any).destination?.address || (ride as any).destination?.address,
      coordinates: (passenger as any).destination?.coordinates || (ride as any).destination?.coordinates,
    },
    departureDate: ride.departureDate,
    departureTime: ride.departureTime,
    rideType: ride.type,
    requestedSeats: (passenger as any).requestedSeats || 1,
    estimatedFare: (passenger as any).estimatedFare || booking.totalFare || 0,
    estimatedDistanceKm: (passenger as any).estimatedDistanceKm || 0,
    estimatedDurationMinutes: (passenger as any).estimatedDurationMinutes || 0,
    status: PASSENGER_STATUS.pending,
    createdAt: (passenger as any).createdAt,
  };

  let notified = 0;
  if (ride.type === RIDE_TYPE.split) {
    const existingDriverId = (ride as any).driverId?.toString();
    if (existingDriverId) {
      io.to(`driver:${existingDriverId}`).emit('ride:new-request', ridePayload);
      notified = 1;

      const driverUser = await User.findById(existingDriverId).select('fcmToken').lean();
      if (driverUser?.fcmToken) {
        sendNotification([driverUser.fcmToken], {
          receiver: existingDriverId,
          message: 'New Split Ride Request!',
          description: 'A passenger wants to join your split ride.',
          reference: passenger._id.toString(),
          modelType: modeType.Passenger,
          data: {
            type: 'SPLIT_RIDE_REQUEST',
            rideId: ride._id.toString(),
            passengerId: passenger._id.toString(),
            bookingId: booking._id.toString(),
            rideType: 'split',
          },
        }).catch(() => {});
      }

      await Ride.findByIdAndUpdate(ride._id, {
        $addToSet: { notifiedDriverIds: existingDriverId },
      });
    } else {
      const pickupCoords = (passenger as any).pickup?.coordinates || (ride as any).pickup?.coordinates;
      notified = await notifyNearbyDriversForSplitRide(
        ride._id.toString(),
        (ride as any).routeGeometry,
        { lat: pickupCoords[1], lng: pickupCoords[0] },
        ridePayload,
        redis,
        io,
        passenger._id.toString()
      );
    }
  } else {
    const pickupCoords = (ride as any).pickup.coordinates;
    notified = await notifyNearbyDrivers(
      ride._id.toString(),
      { lat: pickupCoords[1], lng: pickupCoords[0] },
      ridePayload,
      redis,
      io,
      passenger._id.toString(),
      10,
      undefined,
      { notifyMode: 'all_eligible' }
    );
  }

  await redis.hset(`ride:request:${ride._id}`, {
    bookingId: booking._id.toString(),
    passengerId: passenger._id.toString(),
    notifiedCount: notified.toString(),
    matchingStatus: notified > 0 ? 'notified' : 'scheduled_pending',
    lastNotifiedAt: notified > 0 ? Date.now().toString() : '',
  });
  await redis.zadd('ride:matching:queue', new Date(`${ride.departureDate}T${ride.departureTime}:00`).getTime(), ride._id.toString());

  return notified;
};

/* =====================================================
   🔹 CREATE PAYMENT INTENT (IN-APP STRIPE SDK)
===================================================== */
const createPaymentIntent = async (payload: {
  booking: string;
  user: string;
  paymentMethodId?: string;
}) => {
  const { booking: bookingId, user: userId, paymentMethodId } = payload;

  // ── 1. Validate booking ───────────────────────────────────────────────────
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new ApiError(StatusCodes.NOT_FOUND, 'Booking not found');
  if (booking.userId.toString() !== userId)
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      'This booking does not belong to you'
    );
  if (booking.paymentStatus === PAYMENT_STATUS.paid)
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Payment already completed for this booking'
    );
  const passenger = await Passenger.findById(booking.passengerId).lean();
  if (!passenger) throw new ApiError(StatusCodes.NOT_FOUND, 'Passenger not found');

  const ride = booking.rideId ? await Ride.findById(booking.rideId).lean() : null;
  if (!ride && passenger.status !== PASSENGER_STATUS.split_matching) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');
  }

  const scheduleSource: any = ride || passenger;
  const rideTypeForSchedule = ride?.type || RIDE_TYPE.split;
  await assertMinimumBookingLeadTime(
    scheduleSource.departureDate,
    scheduleSource.departureTime,
    rideTypeForSchedule
  );

  // ── 2. Validate user ──────────────────────────────────────────────────────
  const user = await User.findById(userId);
  if (!user || user.isDeleted)
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');

  // ── 3. Create / reuse Stripe customer for in-app SDK + saved cards ────────
  let customerId = user.customerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: user.name || 'Customer',
      email: user.email || undefined,
      metadata: { userId: user._id.toString() },
    });

    customerId = customer.id;
    await User.findByIdAndUpdate(userId, { customerId });
  }

  if (paymentMethodId) {
    const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);

    if (paymentMethod.type !== 'card') {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'Only card payments are allowed');
    }

    if (
      paymentMethod.customer &&
      paymentMethod.customer.toString() !== customerId
    ) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        'This card does not belong to this user'
      );
    }
  }

  const ephemeralKey = await stripe.ephemeralKeys.create(
    { customer: customerId },
    { apiVersion: '2026-06-24.dahlia' }
  );

  // ── 4. Get platform commission from settings ──────────────────────────────
  const totalFare = Math.round(booking.totalFare * 100) / 100;
  const rideType = (ride?.type || RIDE_TYPE.private) as 'private' | 'split';
  const isMatchedSplit =
    rideType === RIDE_TYPE.split &&
    Number((passenger as any).surchargeAmount || 0) > 0;
  const { platformCommission, providerEarning, commissionPercent } =
    await getCommissionBreakdown(totalFare, rideType, isMatchedSplit);

  if (totalFare <= 0) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Invalid payment amount');
  }

  console.log(
    `💰 Fare: ${totalFare} | Commission (${commissionPercent}%): ${platformCommission} | Provider: ${providerEarning}`
  );

  // ── 5. Check existing unpaid payment ──────────────────────────────────────
  const transactionId = generateTransactionId();

  let payment = await Payment.findOne({
    booking: bookingId,
    user: userId,
    isPaid: false,
  });

  if (!payment) {
    payment = await Payment.create({
      user: userId,
      provider: booking.driverId,
      booking: bookingId,
      method: PAYMENT_METHOD.card,
      transactionId,
      amount: totalFare,
      authorizedAmount: totalFare,
      amountToCapture: totalFare,
      authorizationExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      platformCommission,
      providerEarning,
      status: PAYMENT_STATUS.unpaid,
      isPaid: false,
    });
  } else {
    payment.transactionId = transactionId;
    payment.amount = totalFare;
    payment.authorizedAmount = totalFare;
    payment.amountToCapture = totalFare;
    payment.authorizationExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    payment.platformCommission = platformCommission;
    payment.providerEarning = providerEarning;
    payment.method = PAYMENT_METHOD.card;
    await payment.save();
  }

  // ── 6. Create Stripe PaymentIntent for frontend Stripe SDK ────────────────
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(totalFare * 100),
    currency: 'eur',
    customer: customerId,
    payment_method_types: ['card'],
    capture_method: 'manual',
    ...(paymentMethodId
      ? { payment_method: paymentMethodId, confirm: true }
      : {}),
    metadata: {
      bookingId: bookingId.toString(),
      userId: userId.toString(),
      paymentId: payment._id.toString(),
    },
    description: `Ride Booking - ${booking._id}`,
  });

  payment.paymentIntentId = paymentIntent.id;
  payment.authorizedAmount = totalFare;
  payment.amountToCapture = totalFare;
  payment.authorizationExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await payment.save();

  return {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
    paymentStatus: paymentIntent.status,
    requiresAction: paymentIntent.status === 'requires_action',
    paymentId: payment._id,
    customerId,
    ephemeralKey: ephemeralKey.secret,
    bookingShortId: (booking as any).id,
    notifiedDrivers: 0,
  };
};

const confirmPayment = async (payload: Record<string, any>) => {
  const { paymentIntentId: requestedPaymentIntentId, paymentId } = payload;

  const session = await startSession();
  let paymentIntentId: string | null = requestedPaymentIntentId || null;
  let transactionStarted = false;
  let recalcRideId: string | null = null;

  try {
    if (!paymentIntentId && !paymentId) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Payment intent ID or payment ID is required'
      );
    }

    const paymentIntent = paymentIntentId
      ? await stripe.paymentIntents.retrieve(paymentIntentId)
      : null;

    if (
      paymentIntent &&
      !['succeeded', 'requires_capture'].includes(paymentIntent.status)
    ) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Payment authorization not successful on Stripe'
      );
    }

    paymentIntentId = paymentIntent?.id || paymentIntentId;
    const resolvedPaymentId = paymentId || paymentIntent?.metadata?.paymentId;

    if (!resolvedPaymentId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Payment ID is required');
    }

    session.startTransaction();
    transactionStarted = true;

    // â”€â”€ 1. Payment check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const payment = await Payment.findById(resolvedPaymentId).session(session);
    if (!payment) throw new ApiError(httpStatus.NOT_FOUND, 'Payment not found');

    // âœ… Idempotency guard â€” already paid, skip everything
    if (payment.isPaid) {
      await session.commitTransaction();
      return payment;
    }

    // â”€â”€ 2. Booking check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const booking = await Booking.findById(payment.booking).session(session);
    if (!booking) throw new ApiError(httpStatus.NOT_FOUND, 'Booking not found');


    if (paymentIntent?.status === 'requires_capture') {
      payment.isPaid = false;
      payment.status = PAYMENT_STATUS.authorized;
      payment.paymentIntentId = paymentIntent.id;
      payment.authorizedAmount = Math.round(((paymentIntent.amount || payment.amount * 100) / 100) * 100) / 100;
      payment.amountToCapture = payment.amountToCapture || payment.authorizedAmount;
      payment.authorizationExpiresAt = payment.authorizationExpiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await payment.save({ session });

      booking.paymentStatus = PAYMENT_STATUS.authorized as any;
      booking.amountPaid = 0;
      await booking.save({ session });

      await Passenger.findByIdAndUpdate(
        booking.passengerId,
        { paymentStatus: PAYMENT_STATUS.authorized },
        { session }
      );

      await session.commitTransaction();
      const notifiedDrivers = await startRideMatchingAfterPayment(booking._id.toString());
      return {
        success: true,
        message: 'Payment authorized successfully. It will be captured at the correct ride payment capture point.',
        payment,
        bookingShortId: (booking as any).id,
        notifiedDrivers,
      };
    }

    if (!booking.driverId) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Driver has not accepted this booking yet. Payment can only be captured after driver acceptance.'
      );
    }

    if (booking.paymentStatus === PAYMENT_STATUS.paid) {
      // Booking already paid but payment record not updated â€” sync it
      await Payment.findByIdAndUpdate(
        payment._id,
        { isPaid: true, status: PAYMENT_STATUS.paid, paymentIntentId },
        { session }
      );
      await session.commitTransaction();
      return payment;
    }

    // â”€â”€ 3. Update payment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    payment.isPaid = true;
    payment.status = PAYMENT_STATUS.paid;
    payment.paymentIntentId = paymentIntentId as string;
    await payment.save({ session });

    // â”€â”€ 4. Update booking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    booking.paymentStatus = PAYMENT_STATUS.paid;
    booking.bookingStatus = BOOKING_STATUS.accepted;
    booking.amountPaid = booking.totalFare;
    await booking.save({ session });

    // â”€â”€ 4.5:  Update passenger â”€â”€â”€â”€â”€â”€
    await Passenger.findByIdAndUpdate(
      booking.passengerId,
      { paymentStatus: PAYMENT_STATUS.paid },
      { returnDocument: 'after' }
    );

    // â”€â”€ 5. Update passenger & ride â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const passenger = await Passenger.findById(booking.passengerId).session(
      session
    );
    if (!passenger)
      throw new ApiError(httpStatus.NOT_FOUND, 'Passenger not found');

    const ride = await Ride.findById(booking.rideId).session(session);
    if (!ride) throw new ApiError(httpStatus.NOT_FOUND, 'Ride not found');

    if (ride.type === RIDE_TYPE.split) {
      recalcRideId = ride._id.toString();
      payment.providerEarning = 0;
      await payment.save({ session });
    }

    // âœ… Seat availability check
    const newBookedSeats =
      (ride.bookedSeats || 0) + (passenger.requestedSeats || 1);
    if (newBookedSeats > ride.totalSeats) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Not enough seats available in the ride'
      );
    }

    // âœ… Bug 5 fix: bookedSeats + malePassengers + femalePassengers all here
    await Ride.findByIdAndUpdate(
      ride._id,
      {
        $inc: {
          bookedSeats: passenger.requestedSeats || 1,
          malePassengers: passenger.malePassengers || 0, // âœ… added
          femalePassengers: passenger.femalePassengers || 0, // âœ… added
        },
      },
      { session }
    );

    // âœ… Redis bookedSeats sync â€” also update driver hash
    const driverId = booking.driverId?.toString();
    if (driverId) {
      const redis = getRedisClient();
      await redis.hincrby(
        `driver:${driverId}:details`,
        'bookedSeats',
        passenger.requestedSeats || 1
      );
    }

    // â”€â”€ 6. Provider wallet update â€” duplicate safe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Only increment wallet if providerEarning > 0 and not already credited
    // We use paymentIntentId as the idempotency key stored on payment doc
    // Since payment.isPaid was false above, this is guaranteed to run once only
    // Provider wallet is credited only after ride completion.

    // â”€â”€ 7. Create chat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const existingChat = await Chat.findOne({ booking: booking._id }).session(
      session
    );
    if (!existingChat) {
      await Chat.create(
        [
          {
            booking: booking._id,
            participants: [booking.userId, booking.driverId as any],
            status: CHAT_STATUS.accepted,
          },
        ],
        { session }
      );
    }

    /* ========= 6. Notifications ========= */
    const user = await User.findById(booking.userId);
    if (user?.fcmToken) await paymentNotifyToUser('SUCCESS', payment, user);

    await session.commitTransaction();

    if (recalcRideId) {
      // Do not report payment completion before existing split passengers
      // have received their fare adjustment.
      try {
        await recalculateSplitFares(recalcRideId, 'passenger_paid');
      } catch (err) {
        // The payment transaction is already committed. A recalculation
        // failure must not trigger the payment rollback/refund path below.
        console.error('Recalculate error after payment:', err);
      }
    }

    return payment;
  } catch (error: any) {
    if (transactionStarted) await session.abortTransaction();

    // Auto-refund on failure
    if (paymentIntentId) {
      try {
        await stripe.refunds.create({ payment_intent: paymentIntentId });
      } catch (refundError: any) {
        console.error('Refund failed:', refundError.message);
      }
    }

    throw new ApiError(httpStatus.BAD_GATEWAY, error.message);
  } finally {
    session.endSession();
  }
};

/* =====================================================
   ðŸ”¹ PAY WITH WALLET (Direct Deduction)
===================================================== */
type TCaptureAuthorizedOptions = {
  incrementRideSeats?: boolean;
  createChat?: boolean;
  recalculateSplit?: boolean;
  updateBookingStatus?: boolean;
};

const getCommissionBreakdown = async (
  totalFare: number,
  rideType: 'private' | 'split' = 'private',
  isMatchedSplit = false,
) => {
  const settings = await loadFareSettings();
  const payout = computeDriverPayoutFromPassengerTotal(
    totalFare,
    rideType,
    settings,
    isMatchedSplit,
  );

  return {
    platformCommission: roundMoney(
      payout.driverPlatformFeeAmount + payout.driverVatAmount,
    ),
    providerEarning: payout.driverEarningAmount,
    commissionPercent: settings.driverPlatformFeePercent,
    vatPercent: settings.driverVatPercent,
    driverGrossAmount: payout.komistraGross,
    driverPlatformFeeAmount: payout.driverPlatformFeeAmount,
    driverVatAmount: payout.driverVatAmount,
  };
};

const captureAuthorizedBookingPayment = async (
  bookingId: string,
  driverId: string,
  options: TCaptureAuthorizedOptions = {}
) => {
  const {
    incrementRideSeats = true,
    createChat = true,
    recalculateSplit = true,
    updateBookingStatus = true,
  } = options;

  const session = await startSession();
  let recalcRideId: string | null = null;

  try {
    session.startTransaction();

    const booking = await Booking.findById(bookingId).session(session);
    if (!booking) throw new ApiError(httpStatus.NOT_FOUND, 'Booking not found');

    const payment = await Payment.findOne({
      booking: bookingId,
      status: { $in: [PAYMENT_STATUS.authorized, PAYMENT_STATUS.requires_reauthorization] },
      isPaid: false,
    }).session(session);

    booking.driverId = new mongoose.Types.ObjectId(driverId) as any;

    if (!payment) {
      await booking.save({ session });
      await session.commitTransaction();
      return null;
    }

    if (payment.status === PAYMENT_STATUS.requires_reauthorization) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Payment requires re-authorization before this ride can be started'
      );
    }

    const finalFare = Math.round(
      Number(payment.amountToCapture || booking.totalFare || payment.amount) * 100
    ) / 100;
    const captureAmount = Math.round(finalFare * 100);

    let capturedIntent: Stripe.PaymentIntent | null = null;
    if (payment.paymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(payment.paymentIntentId);
      if (intent.status === 'requires_capture') {
        capturedIntent = await stripe.paymentIntents.capture(payment.paymentIntentId, {
          amount_to_capture: captureAmount,
        });
      } else if (intent.status === 'succeeded') {
        capturedIntent = intent;
      } else {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Payment cannot be captured. Current status: ${intent.status}`
        );
      }
    }

    if (capturedIntent && capturedIntent.status !== 'succeeded') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Payment capture failed');
    }

    const passenger = await Passenger.findById(booking.passengerId).session(session);
    if (!passenger) throw new ApiError(httpStatus.NOT_FOUND, 'Passenger not found');

    const ride = booking.rideId
      ? await Ride.findById(booking.rideId).session(session)
      : null;
    const rideType = (ride?.type || RIDE_TYPE.private) as 'private' | 'split';
    const isMatchedSplit =
      rideType === RIDE_TYPE.split && Number((passenger as any).surchargeAmount || 0) > 0;
    const { platformCommission, providerEarning } = await getCommissionBreakdown(
      finalFare,
      rideType,
      isMatchedSplit,
    );

    payment.provider = new mongoose.Types.ObjectId(driverId) as any;
    payment.amount = finalFare;
    payment.amountToCapture = finalFare;
    payment.platformCommission = platformCommission;
    payment.providerEarning = providerEarning;
    payment.status = PAYMENT_STATUS.paid;
    payment.isPaid = true;
    await payment.save({ session });

    booking.paymentStatus = PAYMENT_STATUS.paid as any;
    if (updateBookingStatus) booking.bookingStatus = BOOKING_STATUS.accepted;
    booking.totalFare = finalFare;
    booking.amountPaid = finalFare;
    await booking.save({ session });

    await Passenger.findByIdAndUpdate(
      booking.passengerId,
      { paymentStatus: PAYMENT_STATUS.paid, paidAmount: finalFare },
      { session }
    );

    if (ride) {
      if (ride.type === RIDE_TYPE.split) {
        payment.providerEarning = 0;
        await payment.save({ session });
      }
      if (ride.type === RIDE_TYPE.split && recalculateSplit) recalcRideId = ride._id.toString();
      if (incrementRideSeats) {
        await Ride.findByIdAndUpdate(
          ride._id,
          {
            $inc: {
              bookedSeats: passenger.requestedSeats || 1,
              malePassengers: passenger.malePassengers || 0,
              femalePassengers: passenger.femalePassengers || 0,
            },
          },
          { session }
        );
      }
    }
    // Provider wallet is credited only after ride completion.

    if (createChat) {
      const existingChat = await Chat.findOne({ booking: booking._id }).session(session);
      if (!existingChat) {
        await Chat.create(
          [
            {
              booking: booking._id,
              participants: [booking.userId, booking.driverId as any],
              status: CHAT_STATUS.accepted,
            },
          ],
          { session }
        );
      }
    }

    await session.commitTransaction();

    if (recalcRideId) {
      try {
        await recalculateSplitFares(recalcRideId, 'passenger_paid');
      } catch (err) {
        console.error('Recalculate error after capture:', err);
      }
    }

    return payment;
  } catch (error: any) {
    await session.abortTransaction();
    throw new ApiError(httpStatus.BAD_REQUEST, error.message || 'Payment capture failed');
  } finally {
    session.endSession();
  }
};

const cancelAuthorizedBookingPayment = async (bookingId: string) => {
  const payment = await Payment.findOne({
    booking: bookingId,
    status: { $in: [PAYMENT_STATUS.authorized, PAYMENT_STATUS.requires_reauthorization] },
    isPaid: false,
  });

  if (!payment) return false;

  if (payment.paymentIntentId) {
    try {
      const intent = await stripe.paymentIntents.retrieve(payment.paymentIntentId);
      if (intent.status === 'requires_capture') {
        await stripe.paymentIntents.cancel(payment.paymentIntentId);
      }
    } catch (error: any) {
      console.error('Failed to cancel authorized payment:', error.message);
    }
  }

  payment.status = PAYMENT_STATUS.cancelled_authorization;
  payment.isPaid = false;
  payment.amountToCapture = 0;
  await payment.save();

  const booking = await Booking.findById(bookingId);
  if (booking) {
    booking.paymentStatus = PAYMENT_STATUS.cancelled_authorization as any;
    booking.amountPaid = 0;
    await booking.save();

    await Passenger.findByIdAndUpdate(booking.passengerId, {
      paymentStatus: PAYMENT_STATUS.cancelled_authorization,
    });
  }

  return true;
};
const payWithWallet = async (payload: { booking: string; user: string }) => {
  const { booking: bookingId, user: userId } = payload;

  const session = await mongoose.startSession();
  let recalcRideId: string | null = null;
  session.startTransaction();

  try {
    // â”€â”€ 1. Validate Booking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const booking = await Booking.findById(bookingId).session(session);
    if (!booking)
      throw new ApiError(StatusCodes.NOT_FOUND, 'Booking not found');

    if (booking.userId.toString() !== userId) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        'This booking does not belong to you'
      );
    }

    if (booking.paymentStatus === PAYMENT_STATUS.paid) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'Payment already completed');
    }

    // â”€â”€ 2. Validate User & Wallet Balance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const user = await User.findById(userId).session(session);
    if (!user || user.isDeleted) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
    }

    const totalFare = booking.totalFare;

    if (user.wallet < totalFare) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        `Insufficient wallet balance. Required: ${totalFare}, Available: ${user.wallet}`
      );
    }

    const ride = booking.rideId
      ? await Ride.findById(booking.rideId).session(session)
      : null;
    const passenger = await Passenger.findById(booking.passengerId).session(session);
    const rideType = (ride?.type || RIDE_TYPE.private) as 'private' | 'split';
    const isMatchedSplit =
      rideType === RIDE_TYPE.split && Number((passenger as any)?.surchargeAmount || 0) > 0;

    const isMatchingPayment = !booking.driverId;

    // Calculate driver-side commission estimate
    const { platformCommission, providerEarning } = await getCommissionBreakdown(
      totalFare,
      rideType,
      isMatchedSplit,
    );

    const transactionId = generateTransactionId();

    const payment = await Payment.create(
      [
        {
          user: userId,
          provider: booking.driverId,
          booking: bookingId,
          method: PAYMENT_METHOD.wallet,
          transactionId,
          amount: totalFare,
          platformCommission,
          providerEarning,
          status: PAYMENT_STATUS.paid,
          isPaid: true,
          paymentIntentId: null as any,
        },
      ],
      { session }
    );

    await User.findByIdAndUpdate(
      userId,
      { $inc: { wallet: -totalFare } },
      { session, returnDocument: 'after' }
    );

    booking.paymentStatus = PAYMENT_STATUS.paid;
    booking.amountPaid = totalFare;
    if (!isMatchingPayment) {
      booking.bookingStatus = BOOKING_STATUS.accepted;
    }
    await booking.save({ session });

    if (ride?.type === RIDE_TYPE.split) {
      payment[0].providerEarning = 0;
      await payment[0].save({ session });
    }

    if (passenger) {
      await Passenger.findByIdAndUpdate(
        booking.passengerId,
        { paymentStatus: PAYMENT_STATUS.paid },
        { session }
      );

      if (ride && !isMatchingPayment) {
        if (ride.type === RIDE_TYPE.split) {
          recalcRideId = ride._id.toString();
        }

        await Ride.findByIdAndUpdate(
          ride._id,
          {
            $inc: {
              bookedSeats: passenger.requestedSeats || 1,
              malePassengers: passenger.malePassengers || 0,
              femalePassengers: passenger.femalePassengers || 0,
            },
          },
          { session }
        );

        const driverId = booking.driverId?.toString();
        if (driverId) {
          const redis = getRedisClient();
          await redis.hincrby(
            `driver:${driverId}:details`,
            'bookedSeats',
            passenger.requestedSeats || 1
          );
        }
      }
    }

    if (!isMatchingPayment) {
      const existingChat = await Chat.findOne({ booking: booking._id }).session(
        session
      );
      if (!existingChat) {
        await Chat.create(
          [
            {
              booking: booking._id,
              participants: [booking.userId, booking.driverId as any],
              status: CHAT_STATUS.accepted,
            },
          ],
          { session }
        );
      }
    }

    if (user?.fcmToken) await paymentNotifyToUser('SUCCESS', payment[0], user);

    await session.commitTransaction();

    let notifiedDrivers = 0;
    if (isMatchingPayment) {
      notifiedDrivers = await startRideMatchingAfterPayment(booking._id.toString());
    }

    if (recalcRideId) {
      try {
        await recalculateSplitFares(recalcRideId, 'passenger_paid');
      } catch (err) {
        console.error('Recalculate error after wallet payment:', err);
      }
    }

    return {
      success: true,
      message: isMatchingPayment
        ? notifiedDrivers > 0
          ? `Payment successful via Wallet. ${notifiedDrivers} nearby driver(s) notified.`
          : 'Payment successful via Wallet. We will keep looking for a driver.'
        : 'Payment successful via Wallet',
      payment: payment[0],
      booking,
      notifiedDrivers,
    };
  } catch (error: any) {
    await session.abortTransaction();
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      error.message || 'Wallet payment failed'
    );
  } finally {
    session.endSession();
  }
};

const getAllPaymentsFromDB = async (query: Record<string, any>) => {
  const filter: any = {
    status: PAYMENT_STATUS.paid,
    isPaid: true,
  };

  // â”€â”€ Date Range Filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) {
      filter.createdAt.$gte = new Date(query.dateFrom + 'T00:00:00.000Z');
    }
    if (query.dateTo) {
      filter.createdAt.$lte = new Date(query.dateTo + 'T23:59:59.999Z');
    }
  }

  // â”€â”€ Amount Range Filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (query.minAmount || query.maxAmount) {
    filter.amount = {};
    if (query.minAmount) filter.amount.$gte = Number(query.minAmount);
    if (query.maxAmount) filter.amount.$lte = Number(query.maxAmount);
  }

  console.log('ðŸ” Final Filter Applied:', JSON.stringify(filter, null, 2));

  // QueryBuilder-> search, sort, paginate, fields
  const paymentModel = new QueryBuilder(
    Payment.find(filter).populate([
      { path: 'user', select: 'name profileImage' },
    ]),
    query
  )
    .search(['transactionId', 'id'])
    // .filter()
    .sort()
    .paginate()
    .fields();

  const data = await paymentModel.modelQuery;
  const meta = await paymentModel.countTotal();

  return {
    data,
    meta,
  };
};

const getDashboardDataFromDB = async (query: Record<string, unknown>) => {};

const getAPaymentsFromDB = async (id: string) => {
  const payment = await Payment.findById(id).populate([
    { path: 'booking', select: 'user status paymentStatus' },
    { path: 'user', select: 'name email photoUrl phone' },
  ]);
  if (!payment || payment?.isDeleted) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Payment not found!');
  }

  return payment;
};

const refundPayment = async (payload: { intendId: string; amount: number }) => {
  if (!payload?.intendId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Payment intent ID is required');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const refundData = {
      payment_intent: payload.intendId,
      ...(payload.amount && {
        amount: payload.amount * 100,
        reason: 'requested_by_customer' as const,
      }),
    };

    // Find and update payment status
    const payment = await Payment.findOneAndUpdate(
      { paymentIntentId: payload.intendId },
      { status: PAYMENT_STATUS.refunded, isPaid: false },
      { returnDocument: 'after', session }
    );
    if (!payment || payment?.isDeleted) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Payment record not found');
    }

    // Validate and update booking status
    const booking = await Booking.findById(payment.booking).session(session);
    if (!booking) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Booking record not found');
    }

    if (booking.bookingStatus !== BOOKING_STATUS.cancelled) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Only cancelled bookings can be refunded. Please cancel the booking first.'
      );
    }

    await Booking.findByIdAndUpdate(
      payment.booking,
      { paymentStatus: PAYMENT_STATUS.refunded },
      { returnDocument: 'after', session }
    );

    // Process refund via Stripe
    const response = await stripe.refunds.create(refundData);

    // fatch user
    const user = await User.findById(payment.user);
    if (!user || user?.isDeleted) {
      throw new ApiError(httpStatus.NOT_FOUND, 'User not found!');
    }

    // Commit transaction
    await session.commitTransaction();
    session.endSession();

    // sent notify to user when payment is refund
    if (user?.fcmToken) await paymentNotifyToUser('REFUND', payment, user);

    return response;
  } catch (error: any) {
    await session.abortTransaction();
    session.endSession();
    console.error('Refund Error:', error);
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      error.message || 'Refund processing failed'
    );
  }
};

export const PaymentService = {
  createPaymentIntent,
  confirmPayment,
  captureAuthorizedBookingPayment,
  cancelAuthorizedBookingPayment,
  payWithWallet,
  getAllPaymentsFromDB,
  getDashboardDataFromDB,
  getAPaymentsFromDB,
  refundPayment,
};











