// ── withdraw.service.ts ──

import httpStatus from 'http-status';
import mongoose from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import { Withdraw } from './withdraw.model';
import { TWithdrawStatus, WITHDRAW_STATUS } from './withdraw.constant';
import { sendWithdrawNotify } from './withdraw.utils';
import { User } from '../user/user.model';
import { Provider } from '../provider/provider.model';
import { Payment } from '../payment/payment.model';
import { PAYMENT_STATUS } from '../payment/payment.constant';
import { Booking } from '../booking/booking.model';
import { Ride } from '../ride/ride.model';
import { RIDE_STATUS, RIDE_TYPE } from '../ride/ride.constant';
import ApiError from '../../errors/ApiError';

// ── Create withdrawal request ──
const addWithdraw = async (
  payload: { amount: number },
  userId: string,
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // ── 1. Validate user ──
    const user = await User.findById(userId).session(session);
    if (!user || user.isDeleted)
      throw new ApiError(httpStatus.NOT_FOUND, 'User not found');

    // -- 2. Amount validation --------------------------------------------------
    const { amount } = payload;
    if (!amount || amount <= 0)
      throw new ApiError(httpStatus.BAD_REQUEST, 'Withdrawal amount must be greater than 0');

    const walletBalance = user.wallet ?? 0;
    if (amount > walletBalance)
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Insufficient balance. Your current balance is €${walletBalance.toFixed(2)}, but you requested €${amount.toFixed(2)}.`,
      );

    // ── 4. One pending request at a time ──
    const pendingRequest = await Withdraw.findOne({
      user: userId,
      status: WITHDRAW_STATUS.pending,
    }).session(session);

    if (pendingRequest)
      throw new ApiError(
        httpStatus.CONFLICT,
        'You already have a pending withdrawal request. Please wait until it is processed.',
      );

    // ── 5. Create withdrawal ──
    const [withdraw] = await Withdraw.create(
      [
        {
          user:   userId,
          amount,
          status: WITHDRAW_STATUS.pending,
        },
      ],
      { session },
    );

    await session.commitTransaction();

    return withdraw;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// ── Get all withdrawals (admin) ──
const getAllWithdrawsFromDB = async (query: Record<string, unknown>) => {
  const filter: any = {};

  // ── Status Filter ──
  if (query.status) {
    filter.status = query.status;
  }

  // ── Date Range Filter (createdAt) ──
  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) {
      filter.createdAt.$gte = new Date(query.dateFrom + 'T00:00:00.000Z');
    }
    if (query.dateTo) {
      filter.createdAt.$lte = new Date(query.dateTo + 'T23:59:59.999Z');
    }
  }

  // ── Amount Range Filter ──
  if (query.minAmount || query.maxAmount) {
    filter.amount = {};
    if (query.minAmount) {
      filter.amount.$gte = Number(query.minAmount);
    }
    if (query.maxAmount) {
      filter.amount.$lte = Number(query.maxAmount);
    }
  }

  // ── User Filter (by userId) ──
  if (query.userId) {
    filter.user = query.userId;
  }

  console.log('🔍 Withdraw Filter Applied:', JSON.stringify(filter, null, 2));

  const withdrawQuery = new QueryBuilder(
    Withdraw.find(filter).populate([
      { path: 'user', select: 'name profileImage phone email' }
    ]),
    query
  )
    .search(['id'])
    // .filter()                      
    .sort()
    .paginate()
    .fields();

  const [result, meta] = await Promise.all([
    withdrawQuery.modelQuery,
    withdrawQuery.countTotal(),
  ]);

  return { 
    meta, 
    result 
  };
};

// ── Get my withdrawals (provider) ──
const getDateRange = (query: Record<string, unknown>) => {
  const filter = String(query.filter || '').toLowerCase();
  const now = new Date();
  let start: Date | null = null;
  let end: Date | null = null;

  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const endOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

  if (filter === 'today') {
    start = startOfDay(now);
    end = endOfDay(now);
  } else if (filter === 'specific_day' && query.date) {
    const date = new Date(String(query.date));
    start = startOfDay(date);
    end = endOfDay(date);
  } else if (filter === 'week') {
    start = startOfDay(new Date(now));
    start.setDate(start.getDate() - 6);
    end = endOfDay(now);
  } else if (filter === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end = endOfDay(now);
  } else if (filter === 'custom') {
    if (query.dateFrom) start = startOfDay(new Date(String(query.dateFrom)));
    if (query.dateTo) end = endOfDay(new Date(String(query.dateTo)));
  }

  return { start, end };
};

const getMyWithdrawsFromDB = async (
  query: Record<string, unknown>,
  userId: string,
) => {
  const user = await User.findById(userId).select('wallet isDeleted');
  if (!user || user.isDeleted)
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');

  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.max(Number(query.limit) || 10, 1);
  const skip = (page - 1) * limit;
  const { start, end } = getDateRange(query);

  const payments = await Payment.find({
    provider: userId,
    status: PAYMENT_STATUS.paid,
    isPaid: true,
    providerEarning: { $gt: 0 },
  })
    .populate({
      path: 'booking',
      select: 'id rideId bookingStatus paymentStatus totalFare amountPaid',
    })
    .sort({ updatedAt: -1 })
    .lean();

  const bookingIds = payments
    .map((payment: any) => payment.booking?._id)
    .filter(Boolean);
  const rideIds = payments
    .map((payment: any) => payment.booking?.rideId)
    .filter(Boolean);
  const paymentIds = payments.map((payment: any) => payment._id);

  const [rides, splitRides, withdraws] = await Promise.all([
    Ride.find({ _id: { $in: rideIds }, status: RIDE_STATUS.completed })
      .select('id type pickup destination departureDate departureTime completedAt status')
      .lean(),
    Ride.find({
      driverId: userId,
      type: RIDE_TYPE.split,
      status: RIDE_STATUS.completed,
      driverEarningCredited: true,
      driverEarningAmount: { $gt: 0 },
    })
      .select('id pickup destination departureDate departureTime completedAt status driverEarningAmount')
      .lean(),
    Withdraw.find({ user: userId })
      .select('id ride payment booking status amount completedAt')
      .lean(),
  ]);

  const rideMap = new Map(rides.map((ride: any) => [ride._id.toString(), ride]));
  const withdrawByPayment = new Map(
    withdraws
      .filter((withdraw: any) => withdraw.payment)
      .map((withdraw: any) => [withdraw.payment.toString(), withdraw])
  );
  const withdrawByBooking = new Map(
    withdraws
      .filter((withdraw: any) => withdraw.booking)
      .map((withdraw: any) => [withdraw.booking.toString(), withdraw])
  );
  const withdrawByRide = new Map(
    withdraws
      .filter((withdraw: any) => withdraw.ride)
      .map((withdraw: any) => [withdraw.ride.toString(), withdraw])
  );

  const privateEarnings = payments
    .map((payment: any) => {
      const booking = payment.booking;
      const ride = booking?.rideId ? rideMap.get(booking.rideId.toString()) : null;
      if (!booking || !ride || ride.type === RIDE_TYPE.split) return null;

      const reportDate = ride.completedAt || payment.updatedAt;
      const withdraw =
        withdrawByPayment.get(payment._id.toString()) ||
        withdrawByBooking.get(booking._id.toString());

      return {
        id: withdraw?.id || null,
        rideId: ride._id.toString(),
        bookingId: booking._id.toString(),
        paymentId: payment._id.toString(),
        bookingReference: booking.id,
        rideDate: ride.departureDate,
        rideTime: ride.departureTime,
        pickup: ride.pickup,
        destination: ride.destination,
        amountEarned: Math.round((payment.providerEarning || 0) * 100) / 100,
        status: withdraw?.status || null,
        reportDate,
      };
    })
    .filter(Boolean) as any[];

  const splitEarnings = splitRides.map((ride: any) => {
    const withdraw = withdrawByRide.get(ride._id.toString());
    return {
      id: withdraw?.id || null,
      rideId: ride._id.toString(),
      bookingId: withdraw?.booking?.toString() || null,
      paymentId: null,
      bookingReference: ride.id,
      rideDate: ride.departureDate,
      rideTime: ride.departureTime,
      pickup: ride.pickup,
      destination: ride.destination,
      amountEarned: Math.round((ride.driverEarningAmount || 0) * 100) / 100,
      status: withdraw?.status || null,
      reportDate: ride.completedAt,
    };
  });

  const allEarnings = [...privateEarnings, ...splitEarnings]
    .sort((a: any, b: any) => new Date(b.reportDate).getTime() - new Date(a.reportDate).getTime());

  const earnings = allEarnings.filter((item: any) => {
    const reportDate = item.reportDate;
    if (start && reportDate < start) return false;
    if (end && reportDate > end) return false;
    return true;
  });

  const total = earnings.length;
  const totalEarnings = Math.round(
    allEarnings.reduce((sum, item) => sum + (item.amountEarned || 0), 0) * 100
  ) / 100;
  const completedRideCount = new Set(earnings.map((item) => item.rideId)).size;
  const earningsList = earnings
    .slice(skip, skip + limit)
    .map(({ reportDate, ...item }) => item);

  return {
    meta: {
      page,
      limit,
      total,
      totalPage: Math.ceil(total / limit),
    },
    result: {
      walletBalance: user.wallet ?? 0,
      totalEarnings,
      completedRideCount,
      earningsList,
    },
  };
};

// ── Get single withdrawal ──
const getAWithdrawFromDB = async (id: string) => {
  const result = await Withdraw.findById(id).populate([
    { path: 'user', select: 'name email profileImage phone' },
  ]);
  if (!result) throw new ApiError(httpStatus.NOT_FOUND, 'Withdraw not found');
  return result;
};

// ── Update withdrawal status (admin only) ──
// Flow: pending -> completed (wallet deduct + IBAN snapshot)
//       pending -> cancelled (no wallet touch)
const updateWithdrawFromDB = async (
  id: string,
  payload: { status: TWithdrawStatus; note?: string },
) => {
  const { status, note } = payload

  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const withdraw = await Withdraw.findById(id).session(session)
    if (!withdraw) throw new ApiError(httpStatus.NOT_FOUND, 'Withdraw not found')

    const currentStatus = withdraw.status

    if (currentStatus === WITHDRAW_STATUS.completed)
      throw new ApiError(httpStatus.BAD_REQUEST, 'Completed withdrawals cannot be updated')

    if (currentStatus !== WITHDRAW_STATUS.pending)
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot update withdrawal from "${currentStatus}" status.`,
      )

    if (status === WITHDRAW_STATUS.completed) {
      const providerProfile = await Provider.findOne({ userId: withdraw.user })
        .select('ibanNumber')
        .session(session)
      const updatedProvider = await User.findOneAndUpdate(
        { _id: withdraw.user, wallet: { $gte: withdraw.amount } },
        { $inc: { wallet: -withdraw.amount } },
        { session, returnDocument: 'after' },
      )

      if (!updatedProvider)
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Insufficient wallet balance or concurrent request detected.',
        )

      withdraw.status      = WITHDRAW_STATUS.completed
      withdraw.completedAt = new Date()
      withdraw.ibanNumber  = providerProfile?.ibanNumber || withdraw.ibanNumber
      if (note) withdraw.note = note
    }
    else if (status === WITHDRAW_STATUS.cancelled) {
      withdraw.status = WITHDRAW_STATUS.cancelled
      if (note) withdraw.note = note
    }
    else {
      throw new ApiError(httpStatus.BAD_REQUEST, `Invalid status transition: ${currentStatus} -> ${status}`)
    }

    await withdraw.save({ session })

    const user = await User.findById(withdraw.user).session(session)
    if (user) await sendWithdrawNotify(status, withdraw, user)

    await session.commitTransaction()
    return withdraw
  } catch (error) {
    await session.abortTransaction()
    throw error instanceof ApiError
      ? error
      : new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to update withdraw status')
  } finally {
    session.endSession()
  }
}
export const WithdrawService = {
  addWithdraw,
  getAllWithdrawsFromDB,
  getMyWithdrawsFromDB,
  getAWithdrawFromDB,
  updateWithdrawFromDB
};



