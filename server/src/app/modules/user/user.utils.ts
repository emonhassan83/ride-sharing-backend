// modules/user/utils/sendUserStatusNotification.ts
import { sendNotification } from '../../utils/sentPushNotification';
import { modeType } from '../notification/notification.interface';
import { TUser } from './user.interface';

export const sendUserStatusNotifYToUser = async (
  status: 'active' | 'blocked' | 'pending',
  user: TUser
) => {
  if (!user || !user?._id || !user?.fcmToken) return;

  let message: string;
  let description: string;

  if (status === 'active') {
    message = '✅ Account Activated';
    description = 'Your account has been successfully activated. You can now access all available features.';
  } else if (status === 'blocked') {
    message = '🚫 Account Blocked';
    description = 'Your account has been blocked. Please contact support for further assistance.';
  } else {
    message = '⏳ Account Status Updated';
    description = 'Your account status has been updated.';
  }

  const notifyPayload = {
    receiver: user._id,
    message,
    description,
    reference: user._id,
    modelType: modeType.User,
  }

  await sendNotification([user.fcmToken], notifyPayload)
};