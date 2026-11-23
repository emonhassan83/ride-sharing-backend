import { modeType } from '../notification/notification.interface'
import { TUser } from '../user/user.interface'
import { TRefund } from './refund.interface'
import { REFUND_STATUS } from './refund.constant'
import { sendNotification } from '../../utils/sentPushNotification'

/**
 * Title + body for a refund status push. Every string here is a translation key
 * (all 5 locales). The title used to be "" which, besides an empty push, made
 * the Notification save fail validation ("Message is required").
 */
export const buildRefundStatusNotification = (
  status: TRefund['status'] | string | undefined,
  note?: string,
): { message: string; description: string } => {
  const adminNote = note?.trim()

  if (status === REFUND_STATUS.confirmed) {
    return {
      message: 'Refund Approved',
      description: 'Your refund has been added to your wallet.',
    }
  }
  if (status === REFUND_STATUS.rejected) {
    return {
      message: 'Refund Rejected',
      // The admin's reason is the most useful text for a rejection.
      description: adminNote || 'Your refund request was rejected.',
    }
  }
  return {
    message: 'Refund Update',
    description: adminNote || 'Your refund request has been updated.',
  }
}

export const refundChangeStatusNotifyToUser = async (
  action: 'CHANGED_STATUS',
  user: TUser,
  refund: TRefund,
  note: string,
) => {
  if (action !== 'CHANGED_STATUS') throw new Error('Invalid action type')
  if (!user.fcmToken) return

  const { message, description } = buildRefundStatusNotification(refund?.status, note)

  await sendNotification([user.fcmToken], {
    receiver: user?._id,
    message,
    description,
    reference: refund?._id,
    modelType: modeType.Refund,
    data: {
      type: 'REFUND_ISSUED',
      refundId: refund?._id ? String(refund._id) : undefined,
      refundStatus: refund?.status,
      amount: refund?.amount,
    },
  })
}
