import { User } from '../modules/user/user.model';
import { Notification } from '../modules/notification/notification.model';
import { modeType } from '../modules/notification/notification.interface';
import { sendNotification } from './sentPushNotification';
import { normalizeLanguage, sanitizeText, translateText } from '../i18n/i18n';

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

  try {
    const user = await User.findById(userId)
      .select('fcmToken language')
      .lean();
    const userLang = normalizeLanguage(user?.language);
    const localizedMessage = translateText(sanitizeText(message), userLang);
    const localizedDescription = translateText(
      sanitizeText(description),
      userLang,
    );

    const notificationPayload = {
      receiver: userId,
      message: localizedMessage,
      description: localizedDescription,
      reference,
      modelType,
      language: userLang,
      ...(data ? { data } : {}),
    };

    const persistInApp = async () => {
      await Notification.create({
        receiver: userId,
        message: localizedMessage,
        description: localizedDescription,
        reference,
        modelType,
      });
    };

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
      await Notification.create({
        receiver: userId,
        message: translateText(sanitizeText(message)),
        description: translateText(sanitizeText(description)),
        reference,
        modelType,
      });
    } catch {
      /* ignore */
    }
  }
}
