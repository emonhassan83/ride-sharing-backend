import httpStatus from 'http-status'
import QueryBuilder from '../../builder/QueryBuilder'
import { Withdraw } from './withdraw.model'
import { TWithdrawStatus, WITHDRAW_STATUS } from './withdraw.constant'
import {
  getThisMonthWithdraw,
  getWithdrawMonthlyOverview,
  sendWithdrawNotify,
} from './withdraw.utils'
import { User } from '../user/user.model'
import mongoose from 'mongoose'
import { Booking } from '../booking/booking.model'
import { Payment } from '../payment/payment.model'
import dayjs from 'dayjs'
import ApiError from '../../errors/ApiError'

// Test purpose-এ withdraw request তৈরি
const addWithdraw = async (payload: { booking: string }, userId: string) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    // Validate user
    const user = await User.findById(userId)
    if (!user || user.isDeleted) {
      throw new ApiError(
        httpStatus.FORBIDDEN,
        'Only consultants can create withdrawal requests',
      )
    }

    // check booking
    const booking = await Booking.findOne({
      _id: payload.booking,
      consult: userId,
      isDeleted: false,
    }).session(session)
    if (!booking) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Booking not found or not yours')
    }

    // Booking of payment found
    const payment = await Payment.findOne({
      booking: booking._id,
      isPaid: true,
      isDeleted: false,
    }).session(session)
    if (!payment) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'No paid payment found for this booking',
      )
    }

    // consultAmount find
    const consultAmount = payment.providerEarning || payment.amount
    if (consultAmount <= 0) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'No amount available for withdrawal',
      )
    }

    // check (duplicate prevent)
    const existingWithdraw = await Withdraw.findOne({
      booking: booking._id,
      user: userId,
      isDeleted: false,
    }).session(session)

    if (existingWithdraw) {
      throw new ApiError(
        httpStatus.CONFLICT,
        'Withdrawal request already exists for this booking',
      )
    }

    // new withdraw request check
    const [withdraw] = await Withdraw.create(
      [
        {
          user: userId,
          booking: booking._id,
          amount: consultAmount,
          status: WITHDRAW_STATUS.proceed,
        },
      ],
      { session },
    )

    await session.commitTransaction()

    return {
      withdraw,
      message: `Withdrawal request of $${consultAmount} created successfully (pending)`,
    }
  } catch (error) {
    await session.abortTransaction()
    throw error
  } finally {
    session.endSession()
  }
}

const getAllWithdrawsFromDB = async (query: Record<string, unknown>) => {
  const WithdrawQuery = new QueryBuilder(
    Withdraw.find().populate([
      { path: 'user', select: 'firstName lastName email photoUrl' },
    ]),
    query,
  )
    .search([])
    .filter()
    .sort()
    .paginate()
    .fields()

  const result = await WithdrawQuery.modelQuery
  const meta = await WithdrawQuery.countTotal()

  return {
    meta,
    result,
  }
}

const getConsultWithdrawsFromDB = async (
  query: Record<string, unknown>,
  userId: string,
) => {
  const expert = await User.findById(userId)
  if (!expert || expert.isDeleted) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Expert profile not found!')
  }

  const selectedYear = query.year
    ? parseInt(query.year as string, 10)
    : new Date().getFullYear()

  const thisMonthWithdraw = await getThisMonthWithdraw(userId)

  const withdrawOverview = await getWithdrawMonthlyOverview(userId, selectedYear)

  // year filter এর date range
  const yearStart = new Date(`${selectedYear}-01-01`)
  const yearEnd = new Date(`${selectedYear + 1}-01-01`)

  // QueryBuilder এ যাওয়ার আগে custom fields delete করো
  const listQuery = { ...query }
  delete listQuery.year
  delete listQuery.month

  const withdrawQuery = new QueryBuilder(
    Withdraw.find({
      user: userId,
      createdAt: { $gte: yearStart, $lt: yearEnd },
    })
      .populate([
        {
          path: 'booking',
          select: 'sessionType user',
          populate: { path: 'user', select: 'firstName lastName' },
        },
      ])
      .sort({ createdAt: -1 }),
    listQuery,
  )
    .filter()
    .sort()
    .paginate()
    .fields()

  const result = await withdrawQuery.modelQuery
  const meta = await withdrawQuery.countTotal()

  return {
    meta,
    result: { thisMonthWithdraw, withdrawOverview, withdrawList: result },
  }
}

const getAWithdrawFromDB = async (id: string) => {
  const result = await Withdraw.findById(id).populate([
    { path: 'user', select: 'firstName lastName email photoUrl' },
    {
      path: 'booking',
      populate: [
        {
          path: 'user',
          select: 'firstName lastName email photoUrl',
        },
        {
          path: 'slot',
          select: 'date time',
        },
      ],
    },
  ])
  if (!result) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Withdraw not found')
  }

  return result
}

const updateWithdrawFromDB = async (
  id: string,
  payload: { status: TWithdrawStatus; note?: string }
) => {
  const { status, note } = payload;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const withdraw = await Withdraw.findById(id).session(session);
    if (!withdraw) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Withdraw not found');
    }

    const currentStatus = withdraw.status;

    // Validate allowed status transitions
    if (currentStatus === WITHDRAW_STATUS.completed) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Completed withdrawals cannot be updated');
    }

    // Case 1: proceed → hold → clear proceedAt
    if (currentStatus === WITHDRAW_STATUS.proceed && status === WITHDRAW_STATUS.hold) {
      withdraw.proceedAt = undefined;
      withdraw.status = WITHDRAW_STATUS.hold;
    }

    // Case 2: hold → proceed → set proceedAt = now + 3 days
    else if (currentStatus === WITHDRAW_STATUS.hold && status === WITHDRAW_STATUS.proceed) {
      const now = new Date();
      const proceedAtDate = dayjs(now).add(3, 'day').toDate();

      withdraw.proceedAt = proceedAtDate;
      withdraw.status = WITHDRAW_STATUS.proceed;
    }

    // Other status changes (e.g., rejected, etc.) → just update status
    else {
      withdraw.status = status;
    }


    await withdraw.save({ session });

    // Send notification to user
    const user = await User.findById(withdraw.user).session(session);
    if (user) {
      await sendWithdrawNotify(status, withdraw, user, note);
    }

    // // Send email to user about status change
    // if (user && user.emailNotify?.payment) {
    //   await sendWithdrawStatusChangeEmail(user, withdraw, status);
    // }

    // Optional: Log admin action (if you have AuditLog model)
    // await AuditLog.create({ action: 'update_withdraw', adminId, withdrawId: id, oldStatus: currentStatus, newStatus: status, note });

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
  getConsultWithdrawsFromDB,
  getAWithdrawFromDB,
  updateWithdrawFromDB,
}
