import admin from '../config/firebase.config'
import httpStatus from 'http-status'
import { Notification } from '../modules/notification/notification.model'
import ApiError from '../errors/ApiError'

export const sendNotification = async (
  fcmToken: string[],
  payload: any,
): Promise<any> => {
  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens: fcmToken,
      notification: {
        title: payload.message,
        body: payload.description,
      },
      apns: {
        headers: {
          'apns-push-type': 'alert',
        },
        payload: {
          aps: {
            badge: 1,
            sound: 'default',
          },
        },
      },
    })

    if (response.successCount) {
      await Promise.all(
        fcmToken.map(async (token) => {
          if (!token) return

          await Notification.create(payload)

          // Increment unread message count for the user
          // if (payload.receiver) {
          //   await incrementUnreadCount(payload.receiver.toString())
          // }
        }),
      )
    }

    return response
  } catch (error: any) {
    if (error?.code === 'messaging/third-party-auth-error') {
      return null
    }

    throw new ApiError(
      httpStatus.NOT_IMPLEMENTED,
      error.message || 'Failed to send notification',
    )
  }
}
