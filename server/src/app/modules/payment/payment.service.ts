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
import { createCheckoutSession } from './payment.utils';
import { StatusCodes } from 'http-status-codes';
import { Passenger } from '../passenger/passenger.model';
import { Ride } from '../ride/ride.model';
import { Setting } from '../settings/settings.model';

const stripe = new Stripe(config.pay?.secretKey as string, {
  apiVersion: '2026-05-27.dahlia',
  typescript: true,
});

/* =====================================================
   🔹 CREATE PAYMENT INTENT / CHECKOUT SESSION
===================================================== */
const createPaymentIntent = async (payload: {
  booking: string;
  user: string;
}) => {
  const { booking: bookingId, user: userId } = payload;

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

  // ── 3. Get platform commission from settings ──────────────────────────────
  const commissionSetting = await Setting.findOne({
    key: 'platformCommissionPercent',
  }).lean();

  const commissionPercent = Number(commissionSetting?.value ?? 10); // default 10%

  const totalFare = booking.totalFare;
  const platformCommission =
    Math.round(((totalFare * commissionPercent) / 100) * 100) / 100;
  const providerEarning =
    Math.round((totalFare - platformCommission) * 100) / 100;

  console.log(
    `💰 Fare: ${totalFare} | Commission (${commissionPercent}%): ${platformCommission} | Provider: ${providerEarning}`
  );

  // ── 4. Check existing unpaid payment ─────────────────────────────────────
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
    // Recalculate on retry (commission may have changed)
    payment.transactionId = transactionId;
    payment.platformCommission = platformCommission;
    payment.providerEarning = providerEarning;
    await payment.save();
  }

  // ── 5. Create Stripe Checkout Session ────────────────────────────────────
  const checkoutSession = await createCheckoutSession({
    product: {
      amount: totalFare,
      name: `Ride Booking - ${booking._id}`,
      quantity: 1,
    },
    customer: {
      name: user.name || 'Customer',
      email: user.email || '',
    },
    paymentId: payment._id,
  });

  return checkoutSession?.url;
};

const confirmPayment = async (query: Record<string, any>) => {
  const { sessionId, paymentId } = query;

  const session = await startSession();
  let paymentIntentId: string | null = null;
  let transactionStarted = false;

  try {
    const PaymentSession = await stripe.checkout.sessions.retrieve(sessionId);
    paymentIntentId = PaymentSession.payment_intent as string;

    if (PaymentSession.status !== 'complete') {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Payment session is not completed'
      );
    }

    session.startTransaction();
    transactionStarted = true;

    // ── 1. Payment check ──────────────────────────────────────────────────────
    const payment = await Payment.findById(paymentId).session(session);
    if (!payment) throw new ApiError(httpStatus.NOT_FOUND, 'Payment not found');

    // ✅ Idempotency guard — already paid, skip everything
    if (payment.isPaid) {
      await session.commitTransaction();
      return payment;
    }

    // ── 2. Booking check ──────────────────────────────────────────────────────
    const booking = await Booking.findById(payment.booking).session(session);
    if (!booking) throw new ApiError(httpStatus.NOT_FOUND, 'Booking not found');

    if (booking.paymentStatus === PAYMENT_STATUS.paid) {
      // Booking already paid but payment record not updated — sync it
      await Payment.findByIdAndUpdate(
        payment._id,
        { isPaid: true, status: PAYMENT_STATUS.paid, paymentIntentId },
        { session }
      );
      await session.commitTransaction();
      return payment;
    }

    // ── 3. Update payment ─────────────────────────────────────────────────────
    payment.isPaid = true;
    payment.status = PAYMENT_STATUS.paid;
    payment.paymentIntentId = paymentIntentId;
    await payment.save({ session });

    // ── 4. Update booking ─────────────────────────────────────────────────────
    booking.paymentStatus = PAYMENT_STATUS.paid;
    booking.bookingStatus = BOOKING_STATUS.accepted;
    booking.amountPaid = booking.totalFare;
    await booking.save({ session });

    // ── 5. Update passenger & ride ────────────────────────────────────────────
    const passenger = await Passenger.findById(booking.passengerId).session(
      session
    );
    if (!passenger)
      throw new ApiError(httpStatus.NOT_FOUND, 'Passenger not found');

    const ride = await Ride.findById(booking.rideId).session(session);
    if (!ride) throw new ApiError(httpStatus.NOT_FOUND, 'Ride not found');

    const newBookedSeats =
      (ride.bookedSeats || 0) + (passenger.requestedSeats || 1);
    if (newBookedSeats > ride.totalSeats) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Not enough seats available in the ride'
      );
    }

    await Ride.findByIdAndUpdate(
      ride._id,
      { $inc: { bookedSeats: passenger.requestedSeats } },
      { session }
    );

    // ── 6. Provider wallet update — duplicate safe ────────────────────────────
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

    // ── 7. Create chat ────────────────────────────────────────────────────────
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

    await session.commitTransaction();
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
   🔹 PAY WITH WALLET (Direct Deduction)
===================================================== */
const payWithWallet = async (payload: { booking: string; user: string }) => {
  const { booking: bookingId, user: userId } = payload;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // ── 1. Validate Booking ─────────────────────────────────────
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

    // ── 2. Validate User & Wallet Balance ───────────────────────
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

    // ── 3. Calculate Commission ────────────────────────────────
    const commissionSetting = await Setting.findOne({
      key: 'platformCommissionPercent',
    }).lean();
    const commissionPercent = Number(commissionSetting?.value ?? 10);

    const platformCommission =
      Math.round(((totalFare * commissionPercent) / 100) * 100) / 100;
    const providerEarning =
      Math.round((totalFare - platformCommission) * 100) / 100;

    const transactionId = generateTransactionId();

    // ── 4. Create Payment Record ───────────────────────────────
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

    // ── 5. Deduct from User Wallet ─────────────────────────────
    await User.findByIdAndUpdate(
      userId,
      { $inc: { wallet: -totalFare } },
      { session, returnDocument: 'after' }
    );

    // ── 6. Update Booking ───────────────────────────────────────
    booking.paymentStatus = PAYMENT_STATUS.paid;
    booking.bookingStatus = BOOKING_STATUS.accepted;
    booking.amountPaid = totalFare;
    await booking.save({ session });

    // ── 7. Credit Provider Wallet ───────────────────────────────
    if (providerEarning > 0) {
      await User.findByIdAndUpdate(
        booking.driverId,
        { $inc: { wallet: providerEarning } },
        { session }
      );
    }

    // ── 8. Update Ride & Passenger (if needed) ─────────────────
    const passenger = await Passenger.findById(booking.passengerId).session(
      session
    );
    if (passenger) {
      const ride = await Ride.findById(booking.rideId).session(session);
      if (ride) {
        await Ride.findByIdAndUpdate(
          ride._id,
          { $inc: { bookedSeats: passenger.requestedSeats || 1 } },
          { session }
        );
      }
    }

    // ── 9. Create Chat ─────────────────────────────────────────
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

    await session.commitTransaction();

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

  // ── Date Range Filter ─────────────────────────────────────
  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) {
      filter.createdAt.$gte = new Date(query.dateFrom + 'T00:00:00.000Z');
    }
    if (query.dateTo) {
      filter.createdAt.$lte = new Date(query.dateTo + 'T23:59:59.999Z');
    }
  }

  // ── Amount Range Filter ───────────────────────────────────
  if (query.minAmount || query.maxAmount) {
    filter.amount = {};
    if (query.minAmount) filter.amount.$gte = Number(query.minAmount);
    if (query.maxAmount) filter.amount.$lte = Number(query.maxAmount);
  }

  console.log('🔍 Final Filter Applied:', JSON.stringify(filter, null, 2));

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

    // // sent notify to user when payment is refund
    // await paymentNotifyToUser('REFUND', payment, user)

    // // sent notify to admin when payment is refund
    // await paymentNotifyToAdmin('REFUND', payment)

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
