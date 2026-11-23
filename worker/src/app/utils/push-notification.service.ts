// worker/utils/push-notification.service.ts
import { getMessaging, Message } from 'firebase-admin/messaging';

export const sendPushNotification = async (
  payload: {
    fcmToken: string;
    title: string;
    body: string;
    data?: Record<string, string>;
  }
): Promise<{ success: boolean; messageId?: string }> => {
  if (!payload.fcmToken) {
    console.warn('⚠️ No FCM token provided for push notification');
    return { success: false };
  }

  // FCM accepts only string values in `data`; the Admin SDK rejects numbers, booleans and objects.
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload.data || {})) {
    if (value === undefined || value === null) continue;
    data[key] =
      typeof value === 'string'
        ? value
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
  }

  const message: Message = {
    token: payload.fcmToken,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data,
    android: { priority: 'high' },
    apns: { headers: { 'apns-priority': '10' } },
  };

  try {
    const messageId = await getMessaging().send(message);
    console.log(`📱 Push sent successfully | MessageId: ${messageId}`);
    return { success: true, messageId };
  } catch (error: any) {
    console.error('❌ Firebase push failed:', error.message);
    return { success: false };
  }
};