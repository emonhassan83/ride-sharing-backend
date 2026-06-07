// worker/utils/push-notification.service.ts
import admin from 'firebase-admin';

export const sendPushNotification = async (
  payload: {
    fcmToken: string; // ✅ userId এর বদলে fcmToken directly
    title:    string;
    body:     string;
    data?:    Record<string, string>;
  },
): Promise<{ success: boolean; messageId?: string }> => {
  if (!payload.fcmToken) {
    console.warn('⚠️ No FCM token provided');
    return { success: false };
  }

  const message: admin.messaging.Message = {
    token:       payload.fcmToken,
    notification: {
      title: payload.title,
      body:  payload.body,
    },
    data:    payload.data || {},
    android: { priority: 'high' },
    apns:    { headers: { 'apns-priority': '10' } },
  };

  const messageId = await admin.messaging().send(message);
  console.log(`📱 Push sent | MessageId: ${messageId}`);

  return { success: true, messageId };
};