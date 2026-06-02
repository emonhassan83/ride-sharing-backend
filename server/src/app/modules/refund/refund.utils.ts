import { modeType } from '../notification/notification.interface'
import { TUser } from '../user/user.interface'
import { TRefund } from './refund.interface'
import { sendNotification } from '../../utils/sentPushNotification'

export const refundAddNotifyToVendor = async (
  action: 'ADDED',
  user: TUser,
  vendor: TUser,
  refund: TRefund,
) => {
  if (!user.fcmToken) return

  // Determine the message and description based on the action
  let message
  let description

  switch (action) {
    case 'ADDED':
      message = ""
      description = `A refund request has been initiated by ${user?.name} for order.`
      break
    default:
      throw new Error('Invalid action type')
  }

  // Create a notification entry
  const notifyPayload = {
    receiver: vendor?._id,
    message,
    description,
    reference: refund?._id,
    model_type: modeType.Refund,
  }

  await sendNotification([vendor.fcmToken], notifyPayload)
}

export const refundChangeStatusNotifyToUser = async (
  action: 'CHANGED_STATUS',
  user: TUser,
  refund: TRefund,
  note: string,
) => {
  if (!user.fcmToken) return

  // Determine the message and description based on the action
  let message
  let description

  switch (action) {
    case 'CHANGED_STATUS':
      message = ""
      description = `The status of your refund request for order has been updated to "${refund?.status}".`
      break
    default:
      throw new Error('Invalid action type')
  }

  // Create a notification entry
  const notifyPayload = {
    receiver: user?._id,
    message,
    description: note ? note : description,
    reference: refund?._id,
    model_type: modeType.Refund,
  }

  await sendNotification([user.fcmToken], notifyPayload)
}
