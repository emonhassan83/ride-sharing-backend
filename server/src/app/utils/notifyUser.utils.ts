import { User } from '../modules/user/user.model';
import { Notification } from '../modules/notification/notification.model';
import { modeType } from '../modules/notification/notification.interface';
import { sendNotification } from './sentPushNotification';
import { normalizeLanguage, sanitizeText, translateText } from '../i18n/i18n';
import { getRedisClient } from '../config/redis.config';

type NotifyUserInput = {
  userId: string;
  message: string;
  description: string;
  reference: string;
  modelType: modeType;
  data?: Record<string, string | number | boolean | null | undefined>;
  /** Same user + key is sent once until the TTL expires. */
  dedupeKey?: string;
  dedupeTtlSeconds?: number;
};

const DEFAULT_DEDUPE_TTL_SECONDS = 6 * 60 * 60;

async function claimNotificationSlot(
  userId: string,
  dedupeKey?: string,
  ttlSeconds = DEFAULT_DEDUPE_TTL_SECONDS,
): Promise<string | null> {
  if (!dedupeKey) return null;
  const redisKey = `notif:once:${userId}:${dedupeKey}`;
  try {
    const redis = getRedisClient();
    const claimed = await redis.set(redisKey, '1', 'EX', ttlSeconds, 'NX');
    return claimed === 'OK' ? redisKey : '';
  } catch {
    return null;
  }
}

async function releaseNotificationSlot(redisKey: string | null): Promise<void> {
  if (!redisKey) return;
  try {
    await getRedisClient().del(redisKey);
  } catch {
    /* ignore */
  }
}

/**
 * Socket is caller's job. This always tries FCM + guarantees an in-app Notification row.
 */
export async function notifyUserPush(input: NotifyUserInput): Promise<void> {
  const { userId, message, description, reference, modelType, data, dedupeKey, dedupeTtlSeconds } =
    input;

  const slot = await claimNotificationSlot(userId, dedupeKey, dedupeTtlSeconds);
  if (slot === '') return;

  let persisted = false;

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

    const inAppRow = {
      receiver: userId,
      message: localizedMessage,
      description: localizedDescription,
      reference,
      modelType,
    };

    // Save the in-app row first so the list updates even when FCM is slow or missing.
    await Notification.create(inAppRow);
    persisted = true;

    if (user?.fcmToken) {
      await sendNotification([user.fcmToken], {
        ...inAppRow,
        language: userLang,
        skipPersist: true,
        ...(data ? { data } : {}),
      });
    }
  } catch (error) {
    console.error(`notifyUserPush failed for user ${userId}:`, error);
    if (!persisted) {
      try {
        await Notification.create({
          receiver: userId,
          message: translateText(sanitizeText(message)),
          description: translateText(sanitizeText(description)),
          reference,
          modelType,
        });
        persisted = true;
      } catch {
        /* ignore */
      }
    }
    if (!persisted) {
      await releaseNotificationSlot(slot);
    }
  }
}
