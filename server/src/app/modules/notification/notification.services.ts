import moment from 'moment';
import ApiError from '../../errors/ApiError';
import { TNotification } from './notification.interface';
import { Notification } from './notification.model';
import { StatusCodes } from 'http-status-codes';
import QueryBuilder from '../../builder/QueryBuilder';
import {
  decrementUnreadCount,
} from '../../redis/helpers/notification';

const createNotificationIntoDB = async (payload: TNotification) => {
  const notification = await Notification.create(payload);
  if (!notification) {
    throw new ApiError(StatusCodes.CONFLICT, 'Notification not created!');
  }

  //@ts-ignore
  const io = global?.socketio;
  if (io) {
    const ver = 'notification::' + payload?.receiver;
    io.emit(ver, { ...payload, createdAt: moment().format('YYYY-MM-DD') });
  }

  return notification;
};

// get my notifications
const getAllNotificationFromDB = async (query: Record<string, unknown>) => {
  const notificationQuery = new QueryBuilder(Notification.find(), query)
    .filter()
    .sort()
    .paginate()
    .fields();

  const result = await notificationQuery.modelQuery;
  const meta = await notificationQuery.countTotal();
  if (!notificationQuery) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Notification not found!');
  }

  return {
    meta,
    result,
  };
};

const getANotificationFromDB = async (id: string) => {
  const notification = await Notification.findById(id);
  if (!notification) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Notification not found!');
  }

  return notification;
};

const markAsDoneFromDB = async (notificationId: string, userId: string) => {
  const notification = await Notification.findOne({
    _id: notificationId,
    receiver: userId,
  });
  if (!notification) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Notification not found!');
  }

  if (notification.read) {
    return notification;
  }

  notification.read = true;
  await notification.save();

  await decrementUnreadCount(userId);

  return notification;
};

const deleteANotificationFromDB = async (id: string) => {
  const notification = await Notification.findById(id);
  if (!notification) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Notification not found!');
  }

  const wasUnread = !notification.read; // read false

  const deleted = await Notification.findByIdAndDelete(id);

  // unread notification was deleted, so decrement the unread count in Redis
  if (wasUnread && deleted) {
    await decrementUnreadCount(notification.receiver!.toString());
  }

  return deleted;
};

const deleteAllNotificationsFromDB = async (userId: string) => {
  // calculate unread notifications before deletion to adjust the count in Redis
  const unreadBeforeDelete = await Notification.countDocuments({
    receiver: userId,
    read: false,
  });

  const result = await Notification.deleteMany(
    { receiver: userId },
  );
  if (result.deletedCount === 0) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'No notifications found!');
  }

  // unread notification count adjust in Redis after deletion
  if (unreadBeforeDelete > 0) {
    await decrementUnreadCount(userId, unreadBeforeDelete);
  }

  return result;
};

export const NotificationService = {
  createNotificationIntoDB,
  getAllNotificationFromDB,
  getANotificationFromDB,
  markAsDoneFromDB,
  deleteANotificationFromDB,
  deleteAllNotificationsFromDB,
};
