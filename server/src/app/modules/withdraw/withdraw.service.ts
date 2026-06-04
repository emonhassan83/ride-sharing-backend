// ── withdraw.service.ts ───────────────────────────────────────────────────────

import httpStatus from 'http-status';
import mongoose from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import { Withdraw } from './withdraw.model';
import { TWithdrawStatus, WITHDRAW_STATUS } from './withdraw.constant';
import { sendWithdrawNotify } from './withdraw.utils';
import { User } from '../user/user.model';
import dayjs from 'dayjs';
import ApiError from '../../errors/ApiError';

// ── Create withdrawal request ─────────────────────────────────────────────────
const addWithdraw = async (
  payload: { amount: number },
  userId: string,
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // ── 1. Validate user ──────────────────────────────────────────────────────
    const user = await User.findById(userId).session(session);
    if (!user || user.isDeleted)
      throw new ApiError(httpStatus.NOT_FOUND, 'User not found');

    // ── 2. Amount validation ──────────────────────────────────────────────────
    const { amount } = payload;
    if (!amount || amount <= 0)
      throw new ApiError(httpStatus.BAD_REQUEST, 'Withdrawal amount must be greater than 0');

    const walletBalance = user.wallet ?? 0;
    if (amount > walletBalance)
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Insufficient balance. Your current balance is ${walletBalance.toFixed(2)}, but you requested ${amount.toFixed(2)}.`,
      );

    // ── 3. One pending request at a time ──────────────────────────────────────
    const pendingRequest = await Withdraw.findOne({
      user: userId,
      status: WITHDRAW_STATUS.pending,
    }).session(session);

    if (pendingRequest)
      throw new ApiError(
        httpStatus.CONFLICT,
        'You already have a pending withdrawal request. Please wait until it is processed.',
      );

    // ── 4. Atomically deduct wallet ───────────────────────────────────────────
    const updatedUser = await User.findOneAndUpdate(
      { _id: userId, wallet: { $gte: amount } },
      { $inc: { wallet: -amount } },
      { session, new: true },
    );

    if (!updatedUser)
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Insufficient balance or concurrent request detected',
      );

    // ── 5. Create withdrawal ──────────────────────────────────────────────────
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

    return {
      withdraw,
      remainingBalance: updatedUser.wallet,
      message: `Withdrawal request of ${amount} created successfully.`,
    };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// ── Get all withdrawals (admin) ───────────────────────────────────────────────
const getAllWithdrawsFromDB = async (query: Record<string, unknown>) => {
  const withdrawQuery = new QueryBuilder(
    Withdraw.find().populate([{ path: 'user', select: 'name profileImage' }]),
    query,
  )
    .search([])
    .filter()
    .sort()
    .paginate()
    .fields();

  const [result, meta] = await Promise.all([
    withdrawQuery.modelQuery,
    withdrawQuery.countTotal(),
  ]);

  return { meta, result };
};

// ── Get my withdrawals (provider) ─────────────────────────────────────────────
const getMyWithdrawsFromDB = async (
  query: Record<string, unknown>,
  userId: string,
) => {
  const user = await User.findById(userId).select('wallet isDeleted');
  if (!user || user.isDeleted)
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');

  const withdrawQuery = new QueryBuilder(
    Withdraw.find({ user: userId }),
    query,
  )
    .filter()
    .sort()
    .paginate()
    .fields();

  const [withdrawList, meta] = await Promise.all([
    withdrawQuery.modelQuery,
    withdrawQuery.countTotal(),
  ]);

  return {
    meta,
    result: {
      walletBalance: user.wallet ?? 0,
      withdrawList,
    },
  };
};

// ── Get single withdrawal ─────────────────────────────────────────────────────
const getAWithdrawFromDB = async (id: string) => {
  const result = await Withdraw.findById(id).populate([
    { path: 'user', select: 'name email profileImage phone' },
  ]);
  if (!result) throw new ApiError(httpStatus.NOT_FOUND, 'Withdraw not found');
  return result;
};

// ── Update withdrawal status (admin) ─────────────────────────────────────────
const updateWithdrawFromDB = async (
  id: string,
  payload: { status: TWithdrawStatus; note?: string },
) => {
  const { status, note } = payload;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const withdraw = await Withdraw.findById(id).session(session);
    if (!withdraw) throw new ApiError(httpStatus.NOT_FOUND, 'Withdraw not found');

    const currentStatus = withdraw.status;

    // Guard: completed cannot be changed
    if (currentStatus === WITHDRAW_STATUS.completed)
      throw new ApiError(httpStatus.BAD_REQUEST, 'Completed withdrawals cannot be updated');

    // ── Status transition logic ───────────────────────────────────────────────
    if (status === WITHDRAW_STATUS.cancelled) {
      // Any → cancelled: refund wallet
      withdraw.status    = WITHDRAW_STATUS.cancelled;
      withdraw.proceedAt = undefined;
      if (note) withdraw.note = note;

      await User.findByIdAndUpdate(
        withdraw.user,
        { $inc: { wallet: withdraw.amount } },
        { session },
      );
    } else if (status === WITHDRAW_STATUS.proceed) {
      // pending → proceed: set proceedAt = now + 3 days
      if (currentStatus !== WITHDRAW_STATUS.pending && currentStatus !== WITHDRAW_STATUS.cancelled)
        throw new ApiError(httpStatus.BAD_REQUEST, `Cannot move from ${currentStatus} to proceed`);

      withdraw.status    = WITHDRAW_STATUS.proceed;
      withdraw.proceedAt = dayjs().add(3, 'day').toDate();
      if (note) withdraw.note = note;
    } else if (status === WITHDRAW_STATUS.completed) {
      // proceed → completed
      if (currentStatus !== WITHDRAW_STATUS.proceed)
        throw new ApiError(httpStatus.BAD_REQUEST, 'Only proceed withdrawals can be completed');

      withdraw.status      = WITHDRAW_STATUS.completed;
      withdraw.completedAt = new Date();
      if (note) withdraw.note = note;
    } else {
      withdraw.status = status;
      if (note) withdraw.note = note;
    }

    await withdraw.save({ session });

    // Notify user
    const user = await User.findById(withdraw.user).session(session);
    if (user) await sendWithdrawNotify(status, withdraw, user, note);

    await session.commitTransaction();
    return withdraw;
  } catch (error) {
    await session.abortTransaction();
    throw error instanceof ApiError
      ? error
      : new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to update withdraw status');
  } finally {
    session.endSession();
  }
};

export const WithdrawService = {
  addWithdraw,
  getAllWithdrawsFromDB,
  getMyWithdrawsFromDB,
  getAWithdrawFromDB,
  updateWithdrawFromDB,
};