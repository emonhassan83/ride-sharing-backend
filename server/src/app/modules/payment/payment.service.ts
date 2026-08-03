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
import { Ride } from '../ride/ride.model';
import { RIDE_TYPE } from '../ride/ride.constant';
import { Setting } from '../settings/settings.model';
import { getRedisClient } from '../../config/redis.config';
import { recalculateSplitFares } from '../../utils/splitFare.utils';

const stripe = new Stripe(config.pay?.secretKey as string, {
  apiVersion: '2026-06-24.dahlia',
  typescript: true,
});

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
  const commissionSetting = await Setting.findOne({
    key: 'platformCommissionPercent',
  }).lean();

  const commissionPercent = Number(commissionSetting?.value ?? 10);

  const totalFare = Math.round(booking.totalFare * 100) / 100;
  const platformCommission =
    Math.round(((totalFare * commissionPercent) / 100) * 100) / 100;
  const providerEarning =
    Math.round((totalFare - platformCommission) * 100) / 100;

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
      platformCommission,
      providerEarning,
      status: PAYMENT_STATUS.unpaid,
      isPaid: false,
    });
  } else {
    payment.transactionId = transactionId;
    payment.amount = totalFare;
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
    ...(paymentMethodId ? { payment_method: paymentMethodId } : {}),
    metadata: {
      bookingId: bookingId.toString(),
      userId: userId.toString(),
      paymentId: payment._id.toString(),
    },
    description: `Ride Booking - ${booking._id}`,
  });

  payment.paymentIntentId = paymentIntent.id;
  await payment.save();

  return {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
    paymentId: payment._id,
    customerId,
    ephemeralKey: ephemeralKey.secret,
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

    if (paymentIntent && paymentIntent.status !== 'succeeded') {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Payment not successful on Stripe'
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
    if (payment.providerEarning && payment.providerEarning > 0) {
      await User.findByIdAndUpdate(
        payment.provider,
        { $inc: { wallet: payment.providerEarning } },
        { session, returnDocument: 'after' }
      );
    }

    // â”€â”€ 7. Create chat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const existingChat = await Chat.findOne({ booking: booking._id }).session(
      session
    );
    if (!existingChat) {
      await Chat.create(
        [
          {
            booking: booking._id,
            participants: [booking.userId, booking.driverId],
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

    // â”€â”€ 3. Calculate Commission â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const commissionSetting = await Setting.findOne({
      key: 'platformCommissionPercent',
    }).lean();
    const commissionPercent = Number(commissionSetting?.value ?? 10);

    const platformCommission =
      Math.round(((totalFare * commissionPercent) / 100) * 100) / 100;
    const providerEarning =
      Math.round((totalFare - platformCommission) * 100) / 100;

    const transactionId = generateTransactionId();

    // â”€â”€ 4. Create Payment Record â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          paymentIntentId: null as any, // No Stripe
        },
      ],
      { session }
    );

    // â”€â”€ 5. Deduct from User Wallet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await User.findByIdAndUpdate(
      userId,
      { $inc: { wallet: -totalFare } },
      { session, returnDocument: 'after' }
    );

    // â”€â”€ 6. Update Booking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    booking.paymentStatus = PAYMENT_STATUS.paid;
    booking.bookingStatus = BOOKING_STATUS.accepted;
    booking.amountPaid = totalFare;
    await booking.save({ session });

    // â”€â”€ 7. Credit Provider Wallet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (providerEarning > 0) {
      await User.findByIdAndUpdate(
        booking.driverId,
        { $inc: { wallet: providerEarning } },
        { session }
      );
    }

    // â”€â”€ 8. Update Ride & Passenger (if needed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const passenger = await Passenger.findById(booking.passengerId).session(
      session
    );
    if (passenger) {
      await Passenger.findByIdAndUpdate(
        booking.passengerId,
        { paymentStatus: PAYMENT_STATUS.paid },
        { session }
      );

      const ride = await Ride.findById(booking.rideId).session(session);
      if (ride) {
        if (ride.type === RIDE_TYPE.split) {
          recalcRideId = ride._id.toString();
        }

        await Ride.findByIdAndUpdate(
          ride._id,
          {
            $inc: {
              bookedSeats:     passenger.requestedSeats  || 1,
              malePassengers:  passenger.malePassengers  || 0,
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

    // â”€â”€ 9. Create Chat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const existingChat = await Chat.findOne({ booking: booking._id }).session(
      session
    );
    if (!existingChat) {
      await Chat.create(
        [
          {
            booking: booking._id,
            participants: [booking.userId, booking.driverId],
            status: CHAT_STATUS.accepted,
          },
        ],
        { session }
      );
    }

    /* ========= 6. Notifications ========= */
    if (user?.fcmToken) await paymentNotifyToUser('SUCCESS', payment[0], user);

    await session.commitTransaction();

    if (recalcRideId) {
      try {
        await recalculateSplitFares(recalcRideId, 'passenger_paid');
      } catch (err) {
        console.error('Recalculate error after wallet payment:', err);
      }
    }

    return {
      success: true,
      message: 'Payment successful via Wallet',
      payment: payment[0],
      booking,
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
  payWithWallet,
  getAllPaymentsFromDB,
  getDashboardDataFromDB,
  getAPaymentsFromDB,
  refundPayment,
};


