import { modeType } from '../notification/notification.interface'
import { TUser } from '../user/user.interface'
import { TWithdraw } from './withdraw.interface'
import { TWithdrawStatus, WITHDRAW_STATUS } from './withdraw.constant'
import dayjs from 'dayjs'
import { Withdraw } from './withdraw.model'
import { Types } from 'mongoose'
import { sendNotification } from '../../utils/sentPushNotification'

export const sendWithdrawNotify = async (
  action: TWithdrawStatus,
  withdraw: TWithdraw,
  user: TUser,
  note?: string
) => {
  if (!user?.fcmToken) return
  
  let message = ''
  let description = ''

  const formattedAmount = `${withdraw.amount.toFixed(2)}`

  switch (action) {
    case 'hold':
      message =  'Withdrawal Request On Hold'
      description = `Your withdrawal request of ${formattedAmount} is currently on hold. We will review it soon and notify you.`
      break

    case 'proceed':
      message = 'Withdrawal Processing Started'
      description = `Your withdrawal of ${formattedAmount} has been approved and is now being processed. Funds will be transferred shortly.`
      break

    case 'completed':
      message = 'Withdrawal Completed'
      description = `Your withdrawal of ${formattedAmount} has been successfully completed! Check your bank/stripe account.`
      break

    default:
      throw new Error('Invalid withdraw notification action')
  }

  const notifyPayload = {
    receiver: user._id,
    message,
    description,
    reference: withdraw._id as string,
    modelType: modeType.Withdraw,
  }

  await sendNotification([user.fcmToken], notifyPayload)
}

/**
 * Get total completed withdrawals for the current month (no year/month filter needed)
 */
export const getThisMonthWithdraw = async (userId: string) => {
  const now = dayjs()
  const startOfMonth = now.startOf('month').toDate()
  const endOfMonth = now.endOf('month').toDate()

  const result = await Withdraw.aggregate([
    {
      $match: {
        user: new Types.ObjectId(userId),
        status: { $in: [WITHDRAW_STATUS.completed, WITHDRAW_STATUS.proceed] },
        createdAt: {
          $gte: startOfMonth,
          $lte: endOfMonth,
        },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' },
      },
    },
  ])

  return result[0]?.total || 0
}

/**
 * Get monthly withdrawal overview for a specific year (returns array like [{month: "January", amount: 100}, ...])
 * @param userId - Consultant's user ID
 * @param year - Year to filter (defaults to current year)
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export const getWithdrawMonthlyOverview = async (userId: string, year?: number) => {
  const selectedYear = year || dayjs().year()

  const result = await Withdraw.aggregate([
    {
      $match: {
        user: new Types.ObjectId(userId),
        status: { $in: [WITHDRAW_STATUS.completed, WITHDRAW_STATUS.proceed] },
        createdAt: {
          $gte: new Date(`${selectedYear}-01-01`),
          $lt: new Date(`${selectedYear + 1}-01-01`),
        },
      },
    },
    {
      $group: {
        _id: { $month: '$createdAt' },
        amount: { $sum: '$amount' },
      },
    },
  ])

  // সব 12 মাস fill করো
  return MONTHS.map((month, i) => ({
    month,
    amount: result.find(r => r._id === i + 1)?.amount || 0,
  }))
}