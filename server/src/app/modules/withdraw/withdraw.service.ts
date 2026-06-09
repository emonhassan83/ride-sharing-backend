// ── withdraw.service.ts ───────────────────────────────────────────────────────

import httpStatus from 'http-status';
import mongoose from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import { Withdraw } from './withdraw.model';
import { TWithdrawStatus, WITHDRAW_STATUS } from './withdraw.constant';
import { sendWithdrawNotify } from './withdraw.utils';
import { User } from '../user/user.model';
import ApiError from '../../errors/ApiError';
import stripeService from '../../config/stripe.config'

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

    // ── 2. Stripe account connected কিনা check ────────────────────────────────
    if (!user.stripeAccountId)
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Please connect your Stripe account before requesting a withdrawal.',
      )

    // ── 3. Amount validation ──────────────────────────────────────────────────
    const { amount } = payload;
    if (!amount || amount <= 0)
      throw new ApiError(httpStatus.BAD_REQUEST, 'Withdrawal amount must be greater than 0');

    const walletBalance = user.wallet ?? 0;
    if (amount > walletBalance)
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Insufficient balance. Your current balance is ${walletBalance.toFixed(2)}, but you requested ${amount.toFixed(2)}.`,
      );

    // ── 4. One pending request at a time ──────────────────────────────────────
    const pendingRequest = await Withdraw.findOne({
      user: userId,
      status: WITHDRAW_STATUS.pending,
    }).session(session);

    if (pendingRequest)
      throw new ApiError(
        httpStatus.CONFLICT,
        'You already have a pending withdrawal request. Please wait until it is processed.',
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

    return withdraw;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// ── Get all withdrawals (admin) ───────────────────────────────────────────────
const getAllWithdrawsFromDB = async (query: Record<string, unknown>) => {
  const filter: any = {};

  // ── Status Filter ─────────────────────────────────────────────
  if (query.status) {
    filter.status = query.status;
  }

  // ── Date Range Filter (createdAt) ─────────────────────────────
  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) {
      filter.createdAt.$gte = new Date(query.dateFrom + 'T00:00:00.000Z');
    }
    if (query.dateTo) {
      filter.createdAt.$lte = new Date(query.dateTo + 'T23:59:59.999Z');
    }
  }

  // ── Amount Range Filter ───────────────────────────────────────
  if (query.minAmount || query.maxAmount) {
    filter.amount = {};
    if (query.minAmount) {
      filter.amount.$gte = Number(query.minAmount);
    }
    if (query.maxAmount) {
      filter.amount.$lte = Number(query.maxAmount);
    }
  }

  // ── User Filter (by userId) ───────────────────────────────────
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

// ── Update withdrawal status (admin only) ─────────────────────────────────────
// Flow: pending → proceed (wallet deduct + stripe transfer)
//       pending → cancelled (no wallet touch)
//       proceed → cancelled (wallet refund)
//       proceed → completed (webhook করে অথবা admin manually)
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
 
    // ════════════════════════════════════════════════════════════════
    // pending → proceed: wallet deduct + Stripe transfer
    // ════════════════════════════════════════════════════════════════
    if (status === WITHDRAW_STATUS.proceed) {
      if (currentStatus !== WITHDRAW_STATUS.pending)
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot move from "${currentStatus}" to "proceed". Only pending withdrawals can be proceeded.`,
        )
 
      const provider = await User.findById(withdraw.user)
        .select('stripeAccountId wallet')
        .session(session)
 
      if (!provider)
        throw new ApiError(httpStatus.NOT_FOUND, 'Provider not found')
 
      if (!provider.stripeAccountId)
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Provider has not connected a Stripe account.',
        )
 
      // Atomic wallet deduct
      const updatedProvider = await User.findOneAndUpdate(
        { _id: withdraw.user, wallet: { $gte: withdraw.amount } },
        { $inc: { wallet: -withdraw.amount } },
        { session, new: true },
      )
 
      if (!updatedProvider)
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Insufficient wallet balance or concurrent request detected.',
        )
 
      // Stripe transfer
      let stripeTransfer: any
      try {
        stripeTransfer = await stripeService.transfer(
          Math.round(withdraw.amount * 100), // dollars → cents
          provider.stripeAccountId,
          'usd',
        )
      } catch (stripeError: any) {
        // Stripe fail → wallet restore
        await User.findByIdAndUpdate(
          withdraw.user,
          { $inc: { wallet: withdraw.amount } },
          { session },
        )
        throw new ApiError(
          httpStatus.BAD_GATEWAY,
          `Stripe transfer failed: ${stripeError.message}. Wallet restored.`,
        )
      }
 
      withdraw.status           = WITHDRAW_STATUS.proceed
      withdraw.proceedAt        = new Date()
      withdraw.stripeTransferId = stripeTransfer.id
      if (note) withdraw.note   = note
 
      console.log(`✅ Stripe transfer done | id: ${stripeTransfer.id} | amount: ${withdraw.amount}`)
    }
 
    // ════════════════════════════════════════════════════════════════
    // → cancelled
    // ════════════════════════════════════════════════════════════════
    else if (status === WITHDRAW_STATUS.cancelled) {
      withdraw.status    = WITHDRAW_STATUS.cancelled
      withdraw.proceedAt = undefined
      if (note) withdraw.note = note
 
      // proceed থেকে cancel → wallet already deducted ছিল, refund করো
      if (currentStatus === WITHDRAW_STATUS.proceed) {
        await User.findByIdAndUpdate(
          withdraw.user,
          { $inc: { wallet: withdraw.amount } },
          { session },
        )
        console.log(`💰 Wallet refunded | user: ${withdraw.user} | amount: ${withdraw.amount}`)
      }
      // pending থেকে cancel → wallet touch হয়নি, refund নেই
    }
 
    // ════════════════════════════════════════════════════════════════
    // proceed → completed (admin manually or webhook)
    // ════════════════════════════════════════════════════════════════
    else if (status === WITHDRAW_STATUS.completed) {
      if (currentStatus !== WITHDRAW_STATUS.proceed)
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Only "proceed" withdrawals can be marked as completed.',
        )
 
      withdraw.status      = WITHDRAW_STATUS.completed
      withdraw.completedAt = new Date()
      if (note) withdraw.note = note
    }
 
    else {
      throw new ApiError(httpStatus.BAD_REQUEST, `Invalid status transition: ${currentStatus} → ${status}`)
    }
 
    await withdraw.save({ session })
 
    const user = await User.findById(withdraw.user).session(session)
    if (user) await sendWithdrawNotify(status, withdraw, user, note)
 
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

// ── Stripe Webhook: transfer.paid → mark completed ───────────────────────────
const handleStripeWebhook = async (rawBody: Buffer, signature: string) => {
  let event: any
 
  try {
    event = stripeService.getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET as string,
    )
  } catch (err: any) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Webhook signature verification failed: ${err.message}`)
  }
 
  if (event.type === 'transfer.paid') {
    const transfer = event.data.object
    const withdraw = await Withdraw.findOne({ stripeTransferId: transfer.id })
 
    if (withdraw && withdraw.status === WITHDRAW_STATUS.proceed) {
      withdraw.status      = WITHDRAW_STATUS.completed
      withdraw.completedAt = new Date()
      await withdraw.save()
 
      const user = await User.findById(withdraw.user)
      if (user) {
        await sendWithdrawNotify(WITHDRAW_STATUS.completed, withdraw, user)
      }
 
      console.log(`✅ Webhook: Withdraw ${withdraw._id} marked completed via transfer ${transfer.id}`)
    }
  }
 
  return { received: true }
}

export const WithdrawService = {
  addWithdraw,
  getAllWithdrawsFromDB,
  getMyWithdrawsFromDB,
  getAWithdrawFromDB,
  updateWithdrawFromDB,
  handleStripeWebhook
};