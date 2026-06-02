import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { TUser } from './user.interface';
import { User } from './user.model';
import { TUserRole, TUserStatus, USER_ROLE } from './user.constant';
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

const getAllUsersFromDB = async (query: Record<string, unknown>) => {
  const usersQuery = new QueryBuilder(
    User.find({ isDeleted: false, role: { $ne: USER_ROLE.admin } }).select(
      '_id id name email photoUrl role address contractNumber categories status createdAt'
    ),
    query
  )
    .search(['name'])
    .filter()
    .sort()
    .paginate()
    .fields();

  const result = await usersQuery.modelQuery;
  const meta = await usersQuery.countTotal();

  return {
    meta,
    result,
  };
};

const getSingleUser = async (userId: string): Promise<TUser | null> => {
  const result: any = await User.findById(userId).select('-wallet').lean();
  if (!result || result.isDeleted)
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');

  // calculate Redis to get unread notification count for the user
  let unreadCount = await getUnreadCount(userId);

  // Redis unread count set
  if (unreadCount === null) {
    unreadCount = await Notification.countDocuments({
      receiver: userId,
      read: false,
    });
    await setUnreadCountInRedis(userId, unreadCount);
  }

  // ── Provider data (only if role is provider) ──────────────────────────────
  let providerData = null;
  if (result.role === 'provider') {
    providerData = await Provider.findOne({ userId })
      .select('-rejectionReason -approvedAt -__v')
      .lean();
  }

  let isKycSubmitted = false;
  let hasVehicle = false;

  if (result.role === USER_ROLE.provider) {
    const provider = await Provider.findOne({ userId: result._id });

    isKycSubmitted = !!provider;

    const vehicle = await Vehicle.findOne({ userId: result._id });
    hasVehicle = !!vehicle;
  }

  return {
    ...result,
    unreadCount,
    ...(providerData && { provider: providerData }),
    isKycSubmitted,
    hasVehicle,
  };
};

const getUserBasics = async (id: string) => {
  const result = await User.findById(id)
    .select(
      'name email phone profileImage avgRating totalRating isProfileComplete isKycVerified createdAt'
    )
    .lean();

  if (!result) throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  if (result.isDeleted)
    throw new ApiError(StatusCodes.NOT_FOUND, 'User deleted');

  return { ...result };
};

const getUsersInRadius = async (
  userId: string,
  radius: number,
  role: TUserRole
) => {
  const currentUser = await User.findById(userId);
  if (!currentUser || currentUser?.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  if (!radius) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Radius is required');
  }

  if (!currentUser?.location?.coordinates) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Please turn on your location');
  }

  const { coordinates } = currentUser.location;
  const earthRadiusInMiles = 3963.2;

  const users = await User.find({
    location: {
      $geoWithin: {
        $centerSphere: [coordinates, radius / earthRadiusInMiles],
      },
    },
    _id: { $ne: currentUser._id },
    role,
    status: 'active',
  }).select('location name profileImage');

  if (!users || users.length === 0) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'No users found in this radius');
  }

  return users.map((user) => {
    const obj: any = { ...user.toObject() };
    obj.location = undefined;
    if (user.location?.coordinates) {
      const [lng, lat] = user.location.coordinates;
      obj.coordinates = [lng, lat];
      obj._id = user._id;
    }
    return obj;
  });
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
      new: true,
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
      new: true,
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
    { new: true }
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
      bookingStatus: { $in: ['accepted', 'ongoing'] },
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
        new: true,
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
  getUserBasics,
  changeEmail,
  updateUserStatus,
  updateUserProfile,
  getUsersInRadius,
  updateLocationFromDB,
  deleteUserProfile,
};
