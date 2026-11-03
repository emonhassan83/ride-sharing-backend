import { User } from '../modules/user/user.model';
import { Notification } from '../modules/notification/notification.model';
import { modeType } from '../modules/notification/notification.interface';
import { sendNotification } from './sentPushNotification';

type NotifyUserInput = {
  userId: string;
  message: string;
  description: string;
  reference: string;
  modelType: modeType;
  data?: Record<string, string | number | boolean | null | undefined>;
};

/**
 * Socket is caller's job. This always tries FCM + guarantees an in-app Notification row.
 */
export async function notifyUserPush(input: NotifyUserInput): Promise<void> {
  const { userId, message, description, reference, modelType, data } = input;

  const notificationPayload = {
    receiver: userId,
    message,
    description,
    reference,
    modelType,
    ...(data ? { data } : {}),
  };

  const persistInApp = async () => {
    await Notification.create({
      receiver: userId,
      message,
      description,
      reference,
      modelType,
    });
  };

  try {
    const user = await User.findById(userId).select('fcmToken').lean();
    let persisted = false;

    if (user?.fcmToken) {
      const response = await sendNotification(
        [user.fcmToken],
        notificationPayload,
      );
      persisted = !!(response && (response as any).successCount > 0);
    }

    if (!persisted) {
      await persistInApp();
    }
  } catch (error) {
    console.error(`notifyUserPush failed for user ${userId}:`, error);
    try {
      await persistInApp();
    } catch {
      /* ignore */
    }
  }
}
