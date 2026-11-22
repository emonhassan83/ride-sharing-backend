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
    message = 'Account Activated';
    description =
      'Your account has been successfully activated. You can now access all available features.';
  } else if (status === 'blocked') {
    message = 'Account Blocked';
    description =
      'Your account has been blocked. Please contact support for further assistance.';
  } else {
    message = 'Account Status Updated';
    description = 'Your account status has been updated.';
  }

  // One FCM + one in-app row. Called only when updateUserStatus actually
  // flipped the status (atomic conditional update), so no dedupe key here —
  // a dedupe TTL would swallow a legit active → blocked → active toggle.
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

  try {
    await incrementUnreadCount(userIdStr);
  } catch {
    /* ignore redis counter errors */
  }

  // Emit ONCE, to the user's own room only. Every socket (rider or driver)
  // joins `user:{id}`, so one emit = one delivery per socket. The old code
  // emitted to `{id}`, `user:{id}`, `driver:{id}` AND broadcast
  // `notification::{id}` to everyone → 3–4 copies of the same notification.
  // Event name matches the app-wide convention (notification.services.ts).
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

    io.to(`user:${userIdStr}`).emit(`notification::${userIdStr}`, socketPayload);
    io.to(`user:${userIdStr}`).emit('user:status-changed', {
      userId: userIdStr,
      status,
      isBlocked: status === 'blocked',
      message,
      description,
      timestamp: Date.now(),
    });
  } catch {
    /* socket may not be initialized in scripts */
  }
};
