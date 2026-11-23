import { modeType } from '../notification/notification.interface'
import { TUser } from '../user/user.interface'
import { TWithdraw } from './withdraw.interface'
import { TWithdrawStatus } from './withdraw.constant'
import { notifyUserPush } from '../../utils/notifyUser.utils'

/**
 * The only push with `screen: earnings`: an admin marks a driver's payout
 * request completed or cancelled. Uses notifyUserPush so the in-app row is
 * saved even without an FCM token and an FCM error never throws.
 */
export const sendWithdrawNotify = async (
  action: TWithdrawStatus,
  withdraw: TWithdraw,
  user: TUser
) => {
  if (!user?._id) return

  let message = ''
  let description = ''

  const formattedAmount = `€${withdraw.amount.toFixed(2)}`

  switch (action) {
    case 'cancelled':
      message =  'Withdrawal Request Cancelled'
      description = `Your withdrawal request of ${formattedAmount} has been cancelled.`
      break

    case 'completed':
      message = 'Withdrawal Completed'
      description = `Your withdrawal of ${formattedAmount} has been successfully completed! Check your bank account.`
      break

    default:
      throw new Error('Invalid withdraw notification action')
  }

  await notifyUserPush({
    userId: String(user._id),
    message,
    description,
    reference: String((withdraw as any)._id),
    modelType: modeType.Withdraw,
    data: {
      type: 'WITHDRAW_STATUS',
      screen: 'earnings',
      withdrawId: String((withdraw as any)._id),
      withdrawStatus: action,
      amount: withdraw.amount.toFixed(2),
    },
  })
}
