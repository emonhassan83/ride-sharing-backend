import { User } from '../modules/user/user.model';
import { Notification } from '../modules/notification/notification.model';
import { modeType } from '../modules/notification/notification.interface';
import { buildNotificationRoutingData, sendNotification } from './sentPushNotification';
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

export const PUSH_MAX_ATTEMPTS = 3;
export const PUSH_RETRY_DELAY_MS = 700;

/** FCM error codes meaning the token will never work again. */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const firstFcmErrorCode = (response: any): string | null => {
  const error = response?.responses?.find((r: any) => r && !r.success)?.error
    ?? response?.responses?.[0]?.error;
  return error?.code || error?.errorInfo?.code || null;
};

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
  if (slot === '') {
    console.warn(`notifyUserPush skipped duplicate user=${userId} key=${dedupeKey}`);
    return;
  }

  let persisted = false;
  let pushed = false;

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

    // B-14: the in-app row keeps the same routing data as the push.
    const routingData = buildNotificationRoutingData({ data, reference, modelType });
    const inAppRow = {
      receiver: userId,
      message: localizedMessage,
      description: localizedDescription,
      reference,
      modelType,
      type: routingData.type,
      data: routingData,
    };

    try {
      await Notification.create(inAppRow);
      persisted = true;
    } catch (error) {
      console.error(`in-app notification create failed for user ${userId}:`, error);
    }

    if (user?.fcmToken) {
      const pushPayload = {
        ...inAppRow,
        language: userLang,
        skipPersist: true,
        ...(data ? { data } : {}),
      };

      // Issue 8: one transient FCM failure used to lose the push for good (the
      // dedupe slot stays claimed because the in-app row was saved).
      for (let attempt = 1; attempt <= PUSH_MAX_ATTEMPTS && !pushed; attempt++) {
        let response: any = null;
        try {
          response = await sendNotification([user.fcmToken], pushPayload);
        } catch (error) {
          response = { successCount: 0, responses: [{ error }] };
        }
        pushed = !!response && response.successCount > 0;
        if (pushed) break;

        const errorCode = firstFcmErrorCode(response);
        if (errorCode && DEAD_TOKEN_CODES.has(errorCode)) {
          // Uninstalled app / rotated token: stop sending to it.
          await User.updateOne(
            { _id: userId, fcmToken: user.fcmToken },
            { $set: { fcmToken: null } },
          ).catch(() => {});
          console.warn(`notifyUserPush: removed dead FCM token for user ${userId} (${errorCode})`);
          break;
        }
        console.error(`FCM not delivered for user ${userId} (attempt ${attempt}):`, errorCode || response);
        if (attempt < PUSH_MAX_ATTEMPTS) await sleep(PUSH_RETRY_DELAY_MS);
      }
    } else {
      console.warn(`notifyUserPush: no fcmToken for user ${userId}`);
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
  }

  if (!persisted && !pushed) {
    await releaseNotificationSlot(slot);
  }
}

/**
 * Fire-and-forget push for socket handlers: FCM retries can take seconds, so a
 * handler must never hold its ack on them. Socket emits stay the caller's job.
 */
export function notifyUserPushInBackground(input: NotifyUserInput): void {
  notifyUserPush(input).catch((error) =>
    console.error(`notifyUserPush (background) failed for user ${input.userId}:`, error),
  );
}
