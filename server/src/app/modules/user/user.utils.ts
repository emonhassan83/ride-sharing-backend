// modules/user/utils/sendUserStatusNotification.ts
import moment from 'moment';
import { modeType } from '../notification/notification.interface';
import { TUser } from './user.interface';
import { notifyUserPush } from '../../utils/notifyUser.utils';
import { incrementUnreadCount } from '../../redis/helpers/notification';
import { getIO } from '../../socket/socket.init';

export const sendUserStatusNotifYToUser = async (
  status: 'active' | 'blocked' | 'pending',
  user: TUser,
) => {
  if (!user || !user?._id) return;

  const userIdStr = user._id.toString();

  let message: string;
  let description: string;

  if (status === 'active') {
    message = '✅ Account Activated';
    description =
      'Your account has been successfully activated. You can now access all available features.';
  } else if (status === 'blocked') {
    message = '🚫 Account Blocked';
    description =
      'Your account has been blocked. Please contact support for further assistance.';
  } else {
    message = '⏳ Account Status Updated';
    description = 'Your account status has been updated.';
  }

  // 1. Send FCM push (when fcmToken exists) + guarantee in-app Notification DB row
  await notifyUserPush({
    userId: userIdStr,
    message,
    description,
    reference: userIdStr,
    modelType: modeType.User,
    data: {
      type: 'ACCOUNT_STATUS',
      status,
      userId: userIdStr,
    },
  });

  // 2. Increment unread notification counter in Redis
  try {
    await incrementUnreadCount(userIdStr);
  } catch {
    /* ignore redis counter errors */
  }

  // 3. Emit real-time Socket.IO notification & status update events
  try {
    const io = getIO();
    const socketPayload = {
      receiver: userIdStr,
      message,
      description,
      reference: userIdStr,
      modelType: modeType.User,
      status,
      createdAt: moment().format('YYYY-MM-DD'),
    };

    io.to(userIdStr).emit('notification', socketPayload);
    io.to(`user:${userIdStr}`).emit('notification', socketPayload);
    io.to(`driver:${userIdStr}`).emit('notification', socketPayload);
    io.emit(`notification::${userIdStr}`, socketPayload);

    const statusChangedPayload = {
      userId: userIdStr,
      status,
      isBlocked: status === 'blocked',
      message,
      description,
      timestamp: Date.now(),
    };
    io.to(userIdStr).emit('user:status-changed', statusChangedPayload);
    io.to(`user:${userIdStr}`).emit('user:status-changed', statusChangedPayload);
    io.to(`driver:${userIdStr}`).emit('user:status-changed', statusChangedPayload);
  } catch {
    /* socket may not be initialized in scripts */
  }
};
