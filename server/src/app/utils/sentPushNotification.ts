import { messaging } from '../config/firebase.config';
import httpStatus from 'http-status';
import { Notification } from '../modules/notification/notification.model';
import { User } from '../modules/user/user.model';
import { USER_ROLE } from '../modules/user/user.constant';
import ApiError from '../errors/ApiError';
import { config } from '../config/env.config';
import {
  resolveUserLanguage,
  sanitizeText,
  translateText,
} from '../i18n/i18n';

/**
 * Web push routing. The web app is one origin for passengers, drivers and
 * admins, so a push must say whose it is: every push now carries
 * `data.recipientRole` (user | provider | admin) and, where a page exists,
 * `data.url` (a frontend path). Mirrors the web app's `inboxUrl`
 * (public/firebase-messaging-sw.js) and `notificationHref`
 * (src/lib/notification-href.ts); a `data.url` set by the caller wins.
 */
const RECIPIENT_ROLES = new Set<string>(Object.values(USER_ROLE));

const NEW_REQUEST_PATTERN = /new[-_ ]?request|ride[-_ ]?request|^request$/;
const MONEY_PATTERN = /wallet|refund|payment|earning|payout|withdraw/;

export const buildNotificationUrl = (
  data: Record<string, string>,
  role?: string | null,
): string | null => {
  const type = String(data.type || '').toLowerCase();
  const screen = String(data.screen || '').toLowerCase();
  const chatId = data.chatId || data.chat;
  const rideId = data.rideId || data.ride;
  const bookingId = data.bookingId || data.booking;
  const passengerId =
    data.passengerId || (data.modelType === 'Passenger' ? data.reference : undefined);

  if (chatId || type === 'chat_message' || screen === 'chat') {
    return chatId ? `/message?chat=${encodeURIComponent(chatId)}` : '/message';
  }

  if (role === USER_ROLE.user) {
    if (type === 'ride_start_otp' && passengerId) return `/my-rides/${passengerId}`;
    if (/wallet|refund|payment/.test(type)) return '/my-rides';
    if (passengerId) return `/my-rides/${passengerId}`;
    // /my-rides/:id takes a PASSENGER id (GET /passenger/:id), so a bare ride
    // id goes to the list instead of a broken detail page.
    if (rideId || bookingId || /ride|booking|trip|passenger|driver|board/.test(type)) return '/my-rides';
    return '/book';
  }

  if (role === USER_ROLE.provider) {
    if (NEW_REQUEST_PATTERN.test(type) || NEW_REQUEST_PATTERN.test(screen)) return '/driver';
    if (MONEY_PATTERN.test(type) || MONEY_PATTERN.test(screen)) return '/driver/my-payments';
    if (/kyc|account/.test(type) || screen === 'home') return '/driver';
    if (rideId) return `/driver/my-rides/${rideId}`;
    if (bookingId) return '/driver/my-rides';
    return '/driver';
  }

  if (role === USER_ROLE.admin) {
    if (/withdraw/.test(type)) return '/admin/withdraw-request';
    if (/refund/.test(type)) return '/admin/refunds';
    if (/kyc/.test(type)) return '/admin/drivers';
    if (bookingId || rideId || data.modelType === 'Booking') return '/admin/bookings';
    return '/admin/dashboard';
  }

  return null;
};

/**
 * Absolute link for `webpush.fcmOptions.link`, from the optional CLIENT_URL
 * (the web app origin). FCM only accepts HTTPS links, and a rejected message
 * would also drop the push on Android/iOS tokens, so anything else is skipped.
 */
export const buildWebPushLink = (url?: string | null): string | null => {
  if (!url || !url.startsWith('/')) return null;
  const base = String(config.client?.url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+/i.test(base)) return null;
  return `${base}${url}`;
};

const resolveRecipientRole = async (
  receiverId?: string,
  given?: unknown,
): Promise<string | null> => {
  if (typeof given === 'string' && RECIPIENT_ROLES.has(given)) return given;
  if (!receiverId) return null;
  try {
    const user = await User.findById(receiverId).select('role').lean();
    const role = (user as any)?.role;
    return typeof role === 'string' && RECIPIENT_ROLES.has(role) ? role : null;
  } catch {
    return null;
  }
};

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

/**
 * B-14: every push and in-app notification carries a routing payload so the
 * app can open the right screen: `type` (UPPER_SNAKE), the target ids and a
 * `screen` hint. Callers that already set `type` keep it; older callers
 * (payment, KYC, withdraw, refund) get a type derived from the model.
 */
const DEFAULT_TYPE_BY_MODEL: Record<string, string> = {
  Ride: 'RIDE_UPDATE',
  Passenger: 'RIDE_UPDATE',
  Booking: 'BOOKING_UPDATE',
  Payment: 'PAYMENT_UPDATE',
  Refund: 'REFUND_ISSUED',
  Withdraw: 'WITHDRAW_STATUS',
  Provider: 'KYC_STATUS',
  User: 'ACCOUNT_STATUS',
  Auth: 'ACCOUNT_STATUS',
};

const screenForType = (type: string): string => {
  if (type === 'CHAT_MESSAGE') return 'chat';
  if (type === 'NEW_RIDE_REQUEST') return 'ride_request';
  if (type === 'KYC_STATUS' || type === 'ACCOUNT_STATUS') return 'home';
  if (type === 'REFUND_ISSUED' || type === 'PAYMENT_UPDATE') return 'wallet';
  if (type === 'WITHDRAW_STATUS') return 'earnings';
  return 'ride_details';
};

export const buildNotificationRoutingData = (payload: {
  data?: Record<string, unknown> | null;
  reference?: unknown;
  modelType?: unknown;
}): Record<string, string> => {
  const out: Record<string, string> = {};
  Object.entries(payload?.data || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) out[key] = String(value);
  });
  const modelType = payload?.modelType ? String(payload.modelType) : '';
  if (payload?.reference) out.reference = String(payload.reference);
  if (modelType) out.modelType = modelType;
  if (!out.type) out.type = DEFAULT_TYPE_BY_MODEL[modelType] || 'GENERAL';
  if (!out.rideId && modelType === 'Ride' && out.reference) out.rideId = out.reference;
  if (!out.screen) out.screen = screenForType(out.type);
  return out;
};

const RIDE_STATE_TYPES = new Set([
  'NEW_RIDE_REQUEST',
  'DRIVERS_NOTIFIED',
  'RIDE_RE_MATCHING',
  'SPLIT_TO_SOLO',
  'RIDE_ACCEPTED',
  'TRIP_STARTED',
  'DRIVER_EN_ROUTE',
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

    const dataPayload = buildNotificationRoutingData(localizedPayload);

    const recipientRole = await resolveRecipientRole(receiverId, payload?.recipientRole);
    if (recipientRole) dataPayload.recipientRole = recipientRole;
    if (!dataPayload.url) {
      const url = buildNotificationUrl(dataPayload, recipientRole);
      if (url) dataPayload.url = url;
    }
    const webPushLink = buildWebPushLink(dataPayload.url);

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
      // Web tokens only (Android/iOS ignore it): FCM shows the notification
      // itself and opens this link on click.
      ...(webPushLink ? { webpush: { fcmOptions: { link: webPushLink } } } : {}),
    }));

    // Firebase Admin v14 uses messaging.sendEach() instead of admin.messaging().sendEachForMulticast()
    const response = await messaging.sendEach(messages);

    if (response.successCount > 0 && !payload?.skipPersist) {
      // Create a single database entry for the notification instead of inside a loop.
      // Callers that already saved the in-app row pass skipPersist.
      await Notification.create({
        ...localizedPayload,
        type: dataPayload.type,
        data: dataPayload,
      });
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
