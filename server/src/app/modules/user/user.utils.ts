import { TUser } from './user.interface';
import { modeType } from '../notification/notification.interface';
import { sendNotification } from '../../utils/sentPushNotification';

// Notification
export const sendUserStatusNotifYToUser = async (
  status: 'active' | 'blocked' | 'pending',
  user: TUser
) => {
  if (!user || !user?.fcmToken) return;

  let message;
  let description;

  if (status === 'active') {
    message = 'User account activated';
    description = `Your account has been successfully activated. You can now access all available features.`;
  } else {
    message = 'User account Blocked.';
    description = `Your account has been blocked. Please contact support for further assistance.`;
  }

  const notifyPayload = {
    receiver: user._id,
    message,
    description,
    reference: user._id,
    modelType: modeType.User,
  };

  await sendNotification([user.fcmToken], notifyPayload);
};
