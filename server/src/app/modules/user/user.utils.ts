// modules/user/utils/sendUserStatusNotification.ts
import { addNotificationJob } from '../../queues/notification.queues';
import { modeType } from '../notification/notification.interface';
import { TUser } from './user.interface';

export const sendUserStatusNotifYToUser = async (
  status: 'active' | 'blocked' | 'pending',
  user: TUser
) => {
  if (!user || !user?._id || !user?.fcmToken) return;

  let title: string;
  let message: string;

  if (status === 'active') {
    title = '✅ Account Activated';
    message = 'Your account has been successfully activated. You can now access all available features.';
  } else if (status === 'blocked') {
    title = '🚫 Account Blocked';
    message = 'Your account has been blocked. Please contact support for further assistance.';
  } else {
    title = '⏳ Account Status Updated';
    message = 'Your account status has been updated.';
  }

  const jobData = {
    userId: user._id.toString(),
    fcmToken: user.fcmToken,
    title,
    message,
    data: {
      receiver: user._id,
      modelType: modeType.User,
      reference: user._id,
    },
    priority: 2 as 2, // Medium priority
  };

  try {
    await addNotificationJob(jobData);
    console.log(`📤 User status notification queued for: ${user._id}`);
  } catch (error) {
    console.error('Failed to queue user status notification:', error);
  }
};