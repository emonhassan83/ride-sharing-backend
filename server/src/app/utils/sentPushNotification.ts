import { messaging } from '../config/firebase.config';
import httpStatus from 'http-status';
import { Notification } from '../modules/notification/notification.model';
import ApiError from '../errors/ApiError';

export const sendNotification = async (
  fcmToken: string[],
  payload: any
): Promise<any> => {
  try {
    // Filter out any empty, null, or undefined tokens before proceeding
    const validTokens = fcmToken.filter((token) => !!token);

    if (validTokens.length === 0) {
      return { successCount: 0, failureCount: 0, responses: [] };
    }

    const dataPayload: Record<string, string> = {};
    const sourceData = payload?.data || {};

    Object.entries(sourceData).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        dataPayload[key] = String(value);
      }
    });

    if (payload?.reference) dataPayload.reference = String(payload.reference);
    if (payload?.modelType) dataPayload.modelType = String(payload.modelType);

    // Map your array of tokens into individual message objects for the new sendEach API
    const messages = validTokens.map((token) => ({
      token: token,
      notification: {
        title: payload.message,
        body: payload.description,
      },
      data: dataPayload,
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
      await Notification.create(payload);

      // If you need to handle per-user tracking in the future,
      // you can read from the 'response.responses' array to find which tokens succeeded or failed.
    }

    return response;
  } catch (error: any) {
    if (error?.code === 'messaging/third-party-auth-error') {
      return null;
    }

    throw new ApiError(
      httpStatus.NOT_IMPLEMENTED,
      error.message || 'Failed to send notification'
    );
  }
};

