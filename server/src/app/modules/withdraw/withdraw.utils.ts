import { modeType } from '../notification/notification.interface'
import { TUser } from '../user/user.interface'
import { TWithdraw } from './withdraw.interface'
import { TWithdrawStatus } from './withdraw.constant'
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
    case 'cancelled':
      message =  'Withdrawal Request Cancelled'
      description = `Your withdrawal request of ${formattedAmount} has been cancelled.`
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