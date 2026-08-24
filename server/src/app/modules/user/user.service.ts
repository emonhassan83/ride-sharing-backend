import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { TUser } from './user.interface';
import { User } from './user.model';
import { TUserStatus, USER_ROLE } from './user.constant';
import mongoose from 'mongoose';
import { sendUserStatusNotifYToUser } from './user.utils';
import { Provider } from '../provider/provider.model';
import {
  getUnreadCount,
  setUnreadCountInRedis,
} from '../../redis/helpers/notification';
import { Notification } from '../notification/notification.model';
import { AccountDeletion } from '../accountDeletion/accountDeletion.model';
import { Booking } from '../booking/booking.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { deleteCache, deleteCachePattern } from '../../redis/helpers';
import { REDIS_KEYS } from '../../redis/keys';
import { createToken, TExpiresIn } from '../auth/auth.utils';
import { config } from '../../config/env.config';
import { Vehicle } from '../vehicle/vehicle.model';
import { Ride } from '../ride/ride.model';
import { RIDE_STATUS, RIDE_TYPE } from '../ride/ride.constant';
import { Payment } from '../payment/payment.model';
import { BOOKING_STATUS } from '../booking/booking.constant';
import StripeService from '../../config/stripe.config';

const getAllUsersFromDB = async (query: Record<string, unknown>) => {
  const usersQuery = new QueryBuilder(
    User.find({ isDeleted: false, role: { $ne: USER_ROLE.admin } }).select(
      '_id id name email profileImage role type address status isOnline isKycVerified createdAt'
    ),
    query
  )
    .search(['name'])
    .filter()
    .sort()
    .paginate()
    .fields();

  const users = await usersQuery.modelQuery;
  const meta = await usersQuery.countTotal();

  // ─── Provider IDs collect করো ────────────────────────────────────
  const providerIds = users
    .filter((u: any) => u.role === USER_ROLE.provider)
    .map((u: any) => new mongoose.Types.ObjectId(u._id));

  // ─── Provider data একবারেই batch fetch করো (N+1 এড়াতে) ──────────
  let completedRidesMap: Record<string, number> = {};
  let totalEarningMap: Record<string, number> = {};

  if (providerIds.length > 0) {
    // Completed rides per provider — একটা aggregation এ সব
    const completedRidesResult = await Ride.aggregate([
      {
        $match: {
          driverId: { $in: providerIds },
          status: RIDE_STATUS.completed,
        },
      },
      {
        $group: {
          _id: '$driverId',
          count: { $sum: 1 },
        },
      },
    ]);

    completedRidesResult.forEach((r) => {
      completedRidesMap[r._id.toString()] = r.count;
    });

    // Total earning per provider: private payments + split ride-level credited earning
    const [totalEarningResult, splitRideEarningResult] = await Promise.all([
      Payment.aggregate([
        {
          $match: {
            provider: { $in: providerIds },
            isPaid: true,
            providerEarning: { $gt: 0 },
          },
        },
        { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'bookingDoc' } },
        { $unwind: { path: '$bookingDoc', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'rides', localField: 'bookingDoc.rideId', foreignField: '_id', as: 'rideDoc' } },
        { $unwind: { path: '$rideDoc', preserveNullAndEmptyArrays: true } },
        { $match: { $or: [{ 'rideDoc.type': { $ne: RIDE_TYPE.split }, 'rideDoc.status': RIDE_STATUS.completed }, { rideDoc: null }] } },
        { $group: { _id: '$provider', total: { $sum: '$providerEarning' } } },
      ]),
      Ride.aggregate([
        {
          $match: {
            driverId: { $in: providerIds },
            type: RIDE_TYPE.split,
            status: RIDE_STATUS.completed,
            driverEarningCredited: true,
            driverEarningAmount: { $gt: 0 },
          },
        },
        { $group: { _id: '$driverId', total: { $sum: '$driverEarningAmount' } } },
      ]),
    ]);

    totalEarningResult.forEach((r) => {
      totalEarningMap[r._id.toString()] = r.total;
    });
    splitRideEarningResult.forEach((r) => {
      const uid = r._id.toString();
      totalEarningMap[uid] = (totalEarningMap[uid] ?? 0) + r.total;
    });
  }

  // ─── Result build করো ────────────────────────────────────────────
  const result = users.map((user: any) => {
    const u = user.toObject ? user.toObject() : user;

    if (u.role !== USER_ROLE.provider) return u;

    const uid = u._id.toString();
    return {
      ...u,
      completedRides: completedRidesMap[uid] ?? 0,
      totalEarning: totalEarningMap[uid] ?? 0,
    };
  });

  return { meta, result };
};

const getSingleUser = async (userId: string): Promise<TUser | null> => {
  const result: any = await User.findById(userId)
    .select('-expireAt -updatedAt -__v')
    .lean();
  if (!result || result.isDeleted)
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');

  // ── Unread notification count (Redis-backed) ──────────────────────────────
  let unreadCount = await getUnreadCount(userId);
  if (unreadCount === null) {
    unreadCount = await Notification.countDocuments({
      receiver: userId,
      read: false,
    });
    await setUnreadCountInRedis(userId, unreadCount);
  }

  // ── Provider-only enrichment ──────────────────────────────────────────────
  let providerData = null;
  let isKycSubmitted = false;
  let hasVehicle = false;
  let vehicles: any[] = [];
  let completedRides = 0;
  let todayEarning = 0;
  let totalEarning = 0;

  if (result.role === USER_ROLE.provider) {
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // ── Run all queries in parallel ───────────────────────────────────────
    const [
      provider,
      vehicleList,
      completedRideCount,
      earningResult,
      splitTodayEarningResult,
      totalEarningResult,
      splitTotalEarningResult,
    ] = await Promise.all([
        // KYC / provider doc
        Provider.findOne({ userId })
          .select(
            '-userId -rejectionReason -approvedAt -updatedAt -createdAt -__v'
          )
          .lean(),

        // All vehicles for this provider
        Vehicle.find({ userId: userObjectId, isDeleted: false })
          .select('name number year seats isDefault')
          .lean(),

        // Completed rides count
        Ride.countDocuments({
          driverId: userObjectId,
          status: RIDE_STATUS.completed,
        }),

        // Today's private earnings from Payment
        Payment.aggregate([
          {
            $match: {
              provider: userObjectId,
              isPaid: true,
              providerEarning: { $gt: 0 },
              createdAt: { $gte: todayStart, $lte: todayEnd },
            },
          },
          { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'bookingDoc' } },
          { $unwind: { path: '$bookingDoc', preserveNullAndEmptyArrays: true } },
          { $lookup: { from: 'rides', localField: 'bookingDoc.rideId', foreignField: '_id', as: 'rideDoc' } },
          { $unwind: { path: '$rideDoc', preserveNullAndEmptyArrays: true } },
          { $match: { $or: [{ 'rideDoc.type': { $ne: RIDE_TYPE.split }, 'rideDoc.status': RIDE_STATUS.completed }, { rideDoc: null }] } },
          { $group: { _id: null, total: { $sum: '$providerEarning' } } },
        ]),

        Ride.aggregate([
          {
            $match: {
              driverId: userObjectId,
              type: RIDE_TYPE.split,
              status: RIDE_STATUS.completed,
              driverEarningCredited: true,
              driverEarningAmount: { $gt: 0 },
              completedAt: { $gte: todayStart, $lte: todayEnd },
            },
          },
          { $group: { _id: null, total: { $sum: '$driverEarningAmount' } } },
        ]),

        Payment.aggregate([
          {
            $match: {
              provider: userObjectId,
              isPaid: true,
              providerEarning: { $gt: 0 },
            },
          },
          { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'bookingDoc' } },
          { $unwind: { path: '$bookingDoc', preserveNullAndEmptyArrays: true } },
          { $lookup: { from: 'rides', localField: 'bookingDoc.rideId', foreignField: '_id', as: 'rideDoc' } },
          { $unwind: { path: '$rideDoc', preserveNullAndEmptyArrays: true } },
          { $match: { $or: [{ 'rideDoc.type': { $ne: RIDE_TYPE.split }, 'rideDoc.status': RIDE_STATUS.completed }, { rideDoc: null }] } },
          { $group: { _id: null, total: { $sum: '$providerEarning' } } },
        ]),

        Ride.aggregate([
          {
            $match: {
              driverId: userObjectId,
              type: RIDE_TYPE.split,
              status: RIDE_STATUS.completed,
              driverEarningCredited: true,
              driverEarningAmount: { $gt: 0 },
            },
          },
          { $group: { _id: null, total: { $sum: '$driverEarningAmount' } } },
        ]),
      ]);

    providerData = provider;
    isKycSubmitted = !!provider;
    hasVehicle = vehicleList.length > 0;
    vehicles = vehicleList;
    completedRides = completedRideCount;
    todayEarning = Math.round(((earningResult[0]?.total ?? 0) + (splitTodayEarningResult[0]?.total ?? 0)) * 100) / 100;
    totalEarning = Math.round(((totalEarningResult[0]?.total ?? 0) + (splitTotalEarningResult[0]?.total ?? 0)) * 100) / 100;
  }

  let hasDefaultCard = false;

  if (result.customerId) {
    try {
      const stripe = StripeService.getStripe();
      const customer = await stripe.customers.retrieve(result.customerId);
      if ('invoice_settings' in customer) {
        hasDefaultCard = !!customer.invoice_settings?.default_payment_method;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    ...result,
    unreadCount,
    ...(providerData && { provider: providerData }),
    ...(result.role === USER_ROLE.provider && {
      vehicles,
      completedRides,
      todayEarning,
      totalEarning,
    }),
    isKycSubmitted,
    hasVehicle,
    isConnectedStripe: !!result.stripeAccountId,
    hasDefaultCard,
  };
};

const changeEmail = async (userId: string, payload: { email: string }) => {
  const { email: newEmail } = payload;

  const user = await User.findById(userId);
  console.log({ userId, user });

  if (!user) throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');

  if (!user.isChangeEmailOtpVerified) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Please verify OTP first');
  }

  // ==================== DUPLICATE EMAIL CHECK ====================
  const existingUser = await User.findOne({
    email: newEmail,
    _id: { $ne: userId },
  });

  if (existingUser) {
    throw new ApiError(
      StatusCodes.CONFLICT,
      'This email is already in use by another account'
    );
  }

  // Update email
  user.email = newEmail;
  user.isChangeEmailOtpVerified = false; // Reset flag
  await user.save();

  // Generate new tokens with updated email
  const jwtPayload = {
    userId: user._id,
    email: newEmail,
    role: user.role,
  };

  const accessToken = createToken(
    jwtPayload,
    config.jwt.accessSecret as string,
    config.jwt.accessExpiration as TExpiresIn
  );

  const refreshToken = createToken(
    jwtPayload,
    config.jwt.refreshSecret as string,
    config.jwt.refreshExpiration as TExpiresIn
  );

  return {
    accessToken,
    refreshToken,
    user: {
      name: user.name,
      email: user.email,
      role: user.role,
      isProfileComplete: user.isProfileComplete,
      status: user.status,
    },
  };
};

const updateUserProfile = async (
  userId: string,
  payload: Partial<TUser> & {
    latitude?: number;
    longitude?: number;
  }
): Promise<Partial<TUser>> => {
  const user = await User.findById(userId);
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found!');
  }

  // Prepare update object
  const updateData: Partial<TUser> & {
    location?: any;
    locationUrl?: string;
  } = { ...payload };

  // Handle location update
  if (payload.latitude && payload.longitude) {
    updateData.location = {
      type: 'Point',
      coordinates: [payload.longitude, payload.latitude],
    };

    // remove extra fields (important)
    delete (updateData as any).latitude;
    delete (updateData as any).longitude;
  }

  // ==================== PHONE CHANGE LOGIC ====================
  if (payload.phone && payload.phone !== user.phone) {
    if (!user.isChangePhoneOtpVerified) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        'Please verify your new phone with OTP first'
      );
    }

    // Duplicate Phone Check
    const existingPhone = await User.findOne({
      phone: payload.phone,
      _id: { $ne: userId },
    });
    if (existingPhone) {
      throw new ApiError(
        StatusCodes.CONFLICT,
        'This phone number is already in use'
      );
    }

    updateData.isChangePhoneOtpVerified = false; // Reset flag
  }

  const result = await User.findByIdAndUpdate(
    userId,
    { ...updateData, isProfileComplete: true },
    {
      returnDocument: 'after',
    }
  )
    .select('-wallet -expireAt -createdAt -updatedAt')
    .lean();
  if (!result) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  return result;
};

const updateUserStatus = async (
  userId: string,
  payload: { status: TUserStatus }
): Promise<TUser | null> => {
  const { status } = payload;

  //* if the user is is not exist
  const user = await User.findById(userId);
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found!');
  }

  const result = await User.findByIdAndUpdate(
    userId,
    { status },
    {
      returnDocument: 'after',
    }
  ).select('name fcmToken email phone status isDeleted');
  if (!result) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  // sent notify to user
  await sendUserStatusNotifYToUser(status, result);

  return result;
};

const updateLocationFromDB = async (
  userId: string,
  payload: { longitude: number; latitude: number; address: string }
) => {
  const { longitude, latitude, address } = payload;

  //* if the user is is not exist
  const user = await User.findById(userId);
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found!');
  }

  if (!longitude || !latitude) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Longitude and latitude are required'
    );
  }

  const updatedUser = await User.findByIdAndUpdate(
    userId,
    {
      location: { type: 'Point', coordinates: [longitude, latitude] },
      address: address,
    },
    { returnDocument: 'after' }
  );

  return updatedUser;
};

const deleteUserProfile = async (
  userId: string,
  payload: { reason: string; otherReason?: string }
): Promise<TUser | null> => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);
    if (!user || user.isDeleted) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'User not found!');
    }

    const activeBooking = await Booking.findOne({
      userId,
      bookingStatus: { $in: [BOOKING_STATUS.accepted, BOOKING_STATUS.running] },
    });
    if (activeBooking) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        'Cannot delete profile while having active bookings'
      );
    }

    // Save deletion reason
    await AccountDeletion.create(
      [
        {
          user: userId,
          reason: payload.reason,
          otherReason: payload.otherReason,
        },
      ],
      { session }
    );

    // Soft delete user
    const deletedUser = await User.findByIdAndUpdate(
      userId,
      {
        isDeleted: true,
        deletedAt: new Date(),
      },
      {
        returnDocument: 'after',
        session,
        select: 'name email phone status isDeleted deletedAt',
      }
    );

    if (!deletedUser) {
      throw new ApiError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        'Failed to delete user'
      );
    }

    await session.commitTransaction();

    // invalidate cache
    await deleteCache(REDIS_KEYS.ACCOUNT_DELETION_ALL);
    await deleteCachePattern('accountDeletion:*');

    return deletedUser;
  } catch (error: any) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

export const UserService = {
  getAllUsersFromDB,
  getSingleUser,
  changeEmail,
  updateUserStatus,
  updateUserProfile,
  updateLocationFromDB,
  deleteUserProfile,
};




