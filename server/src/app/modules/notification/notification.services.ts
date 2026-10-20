import moment from 'moment';
import { Types } from 'mongoose';
import ApiError from '../../errors/ApiError';
import { modeType, TNotification } from './notification.interface';
import { Notification } from './notification.model';
import { StatusCodes } from 'http-status-codes';
import QueryBuilder from '../../builder/QueryBuilder';
import {
  decrementUnreadCount,
  setUnreadCountInRedis,
} from '../../redis/helpers/notification';
import { Passenger } from '../passenger/passenger.model';
import { Booking } from '../booking/booking.model';

const RIDE_META_MODEL_TYPES = new Set<string>([
  modeType.Ride,
  modeType.Passenger,
  modeType.Booking,
]);

const toPlain = (doc: any) =>
  doc?.toObject ? doc.toObject() : { ...doc };

const resolveRideIdForNotification = async (
  modelType?: string,
  reference?: Types.ObjectId | string | null,
): Promise<string | null> => {
  if (!modelType || !reference || !RIDE_META_MODEL_TYPES.has(modelType)) {
    return null;
  }

  const refId = reference.toString();

  if (modelType === modeType.Ride) {
    return refId;
  }

  if (modelType === modeType.Passenger) {
    const passenger = await Passenger.findById(refId).select('rideId').lean();
    return passenger?.rideId ? passenger.rideId.toString() : null;
  }

  if (modelType === modeType.Booking) {
    const booking = await Booking.findById(refId).select('rideId').lean();
    return booking?.rideId ? booking.rideId.toString() : null;
  }

  return null;
};

const withRideMeta = async (notification: any) => {
  const plain = toPlain(notification);
  const rideId = await resolveRideIdForNotification(
    plain.modelType,
    plain.reference,
  );

  if (!RIDE_META_MODEL_TYPES.has(plain.modelType)) {
    return plain;
  }

  return {
    ...plain,
    meta: {
      rideId,
    },
  };
};

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

  const enriched = await Promise.all(result.map((item: any) => withRideMeta(item)));

  return {
    meta,
    result: enriched,
  };
};

const getANotificationFromDB = async (id: string) => {
  const notification = await Notification.findById(id);
  if (!notification) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Notification not found!');
  }

  return withRideMeta(notification);
};

/** Mark all notifications as read for a user */
const markAsDoneFromDB = async (userId: string) => {
  const result = await Notification.updateMany(
    { receiver: userId },
    {
      $set: {
        read: true,
      },
    },
  );

  if (result.modifiedCount > 0) {
    await setUnreadCountInRedis(userId, 0);
  }

  return result;
};

/** Mark a single notification as read by id */
const markAsDoneAFromDB = async (notificationId: string, userId: string) => {
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
  markAsDoneAFromDB,
  deleteANotificationFromDB,
  deleteAllNotificationsFromDB,
};
