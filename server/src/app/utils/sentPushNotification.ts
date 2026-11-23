import { messaging } from '../config/firebase.config';
import httpStatus from 'http-status';
import { Notification } from '../modules/notification/notification.model';
import ApiError from '../errors/ApiError';
import {
  resolveUserLanguage,
  sanitizeText,
  translateText,
} from '../i18n/i18n';

/**
 * Issue 4 ("late notifications") / issue 9 ("same notification many times").
 *
 * Without an expiry FCM keeps an undelivered push for up to 4 weeks, so a phone
 * that was offline or in Doze received "Driver accepted", "Driver arrived",
 * "Trip started" in a burst long after the ride. Live ride updates now expire
 * after RIDE_STATE_TTL_SECONDS; everything else (payments, refunds, chat, KYC)
 * after DEFAULT_TTL_SECONDS.
 *
 * The collapse key (Android tag + collapseKey, iOS apns-collapse-id) makes a
 * newer push for the same ride/event REPLACE the older one in the tray instead
 * of stacking a copy.
 */
export const RIDE_STATE_TTL_SECONDS = 10 * 60;
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

const RIDE_STATE_TYPES = new Set([
  'NEW_RIDE_REQUEST',
  'DRIVERS_NOTIFIED',
  'RIDE_RE_MATCHING',
  'SPLIT_TO_SOLO',
  'RIDE_ACCEPTED',
  'TRIP_STARTED',
  'DRIVER_ARRIVED',
  'PASSENGER_PICKED_UP',
  'BOARD_SOON',
  'RIDE_START_OTP',
]);

export const buildPushDeliveryOptions = (
  data: Record<string, string> = {},
  ttlOverrideSeconds?: number,
): { ttlSeconds: number; collapseKey: string | null; channelId: string | null } => {
  const type = data.type || '';
  const ttlSeconds =
    Number(ttlOverrideSeconds) > 0
      ? Number(ttlOverrideSeconds)
      : RIDE_STATE_TYPES.has(type)
        ? RIDE_STATE_TTL_SECONDS
        : DEFAULT_TTL_SECONDS;

  const scope = data.passengerId || data.rideId || data.chatId || '';
  // APNs limits apns-collapse-id to 64 bytes.
  const collapseKey = type && scope ? `${type}:${scope}`.slice(0, 64) : null;

  // Only set when the app has created this channel (otherwise Android falls back anyway).
  const channelId = process.env.FCM_ANDROID_CHANNEL_ID?.trim() || null;

  return { ttlSeconds, collapseKey, channelId };
};

export const sendNotification = async (
  fcmToken: string[],
  payload: any,
): Promise<any> => {
  try {
    const receiverId = payload?.receiver ? String(payload.receiver) : undefined;
    const recipientLang = await resolveUserLanguage(
      receiverId,
      payload?.language,
    );

    const localizedTitle = payload?.message
      ? translateText(sanitizeText(payload.message), recipientLang)
      : sanitizeText(payload?.message);
    const localizedBody = payload?.description
      ? translateText(sanitizeText(payload.description), recipientLang)
      : sanitizeText(payload?.description);

    const localizedPayload = {
      ...payload,
      message: localizedTitle,
      description: localizedBody,
    };

    // Filter out any empty, null, or undefined tokens before proceeding
    const validTokens = fcmToken.filter((token) => !!token);

    if (validTokens.length === 0) {
      return { successCount: 0, failureCount: 0, responses: [] };
    }

    const dataPayload: Record<string, string> = {};
    const sourceData = localizedPayload?.data || {};

    Object.entries(sourceData).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        dataPayload[key] = String(value);
      }
    });

    if (localizedPayload?.reference) {
      dataPayload.reference = String(localizedPayload.reference);
    }
    if (localizedPayload?.modelType) {
      dataPayload.modelType = String(localizedPayload.modelType);
    }

    const delivery = buildPushDeliveryOptions(dataPayload, payload?.ttlSeconds);

    // Map your array of tokens into individual message objects for the new sendEach API
    const messages = validTokens.map((token) => ({
      token: token,
      notification: {
        title: localizedTitle,
        body: localizedBody,
      },
      data: dataPayload,
      android: {
        priority: 'high' as const,
        ttl: delivery.ttlSeconds * 1000,
        ...(delivery.collapseKey ? { collapseKey: delivery.collapseKey } : {}),
        notification: {
          sound: 'default',
          defaultSound: true,
          ...(delivery.collapseKey ? { tag: delivery.collapseKey } : {}),
          ...(delivery.channelId ? { channelId: delivery.channelId } : {}),
        },
      },
      apns: {
        headers: {
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(
            Math.floor(Date.now() / 1000) + delivery.ttlSeconds,
          ),
          ...(delivery.collapseKey ? { 'apns-collapse-id': delivery.collapseKey } : {}),
        },
        payload: {
          aps: {
            badge: 1,
            sound: 'default',
          },
        },
      },
    }));

    // Firebase Admin v14 uses messaging.sendEach() instead of admin.messaging().sendEachForMulticast()
    const response = await messaging.sendEach(messages);

    if (response.successCount > 0 && !payload?.skipPersist) {
      // Create a single database entry for the notification instead of inside a loop.
      // Callers that already saved the in-app row pass skipPersist.
      await Notification.create(localizedPayload);
    }

    return response;
  } catch (error: any) {
    if (error?.code === 'messaging/third-party-auth-error') {
      return null;
    }

    throw new ApiError(
      httpStatus.NOT_IMPLEMENTED,
      error.message || 'Failed to send notification',
    );
  }
};
