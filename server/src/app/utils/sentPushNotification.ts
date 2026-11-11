import { messaging } from '../config/firebase.config';
import httpStatus from 'http-status';
import { Notification } from '../modules/notification/notification.model';
import ApiError from '../errors/ApiError';
import {
  resolveUserLanguage,
  sanitizeText,
  translateText,
} from '../i18n/i18n';

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
        notification: {
          sound: 'default',
          defaultSound: true,
        },
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
    }));

    // Firebase Admin v14 uses messaging.sendEach() instead of admin.messaging().sendEachForMulticast()
    const response = await messaging.sendEach(messages);

    if (response.successCount > 0) {
      // Create a single database entry for the notification instead of inside a loop
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
