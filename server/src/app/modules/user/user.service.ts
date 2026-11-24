import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { TUser } from './user.interface';
import { User } from './user.model';
import { TUserStatus, USER_ROLE, USER_STATUS } from './user.constant';
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
import { isPastUpcomingWindow } from '../ride/ride.service';
import { DRIVER_TOO_YOUNG_MESSAGE, isAdultDriverDob } from '../../utils/profileValidation.utils';
import { Review } from '../review/review.model';
import { Passenger } from '../passenger/passenger.model';
import { PASSENGER_STATUS } from '../passenger/passenger.constant';
import { Payment } from '../payment/payment.model';
import { BOOKING_STATUS } from '../booking/booking.constant';
import StripeService from '../../config/stripe.config';
import { UserLocation } from '../savedPlaces/savedPlaces.model';
import { getRedisClient } from '../../config/redis.config';
import { getIO, onlineUsers } from '../../socket/socket.init';

const getAllUsersFromDB = async (query: Record<string, unknown>) => {
  // QueryBuilder.filter() drops `role` (elsewhere it is a related-user param),
  // so ?role=provider / ?role=user was ignored here. Admins are never listed.
  const rawRole = String(query.role ?? '').trim().toLowerCase();
  const requestedRole =
    rawRole === 'driver' ? USER_ROLE.provider : rawRole === 'rider' ? USER_ROLE.user : rawRole;
  if (
    requestedRole &&
    requestedRole !== 'all' &&
    requestedRole !== USER_ROLE.user &&
    requestedRole !== USER_ROLE.provider
  ) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Invalid role filter');
  }
  const roleFilter =
    requestedRole === USER_ROLE.user || requestedRole === USER_ROLE.provider
      ? requestedRole
      : { $ne: USER_ROLE.admin };

  const usersQuery = new QueryBuilder(
    User.find({ isDeleted: false, role: roleFilter }).select(
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
    const totalEarning = Math.round((totalEarningMap[uid] ?? 0) * 100) / 100;
    return {
      ...u,
      completedRides: completedRidesMap[uid] ?? 0,
      totalEarning,
      // Same all-time figure under the name the driver's own earnings page uses.
      lifetimeEarnings: totalEarning,
    };
  });

  return { meta, result };
};

const getSingleUser = async (
  userId: string,
  requester?: { userId: string; role: string },
): Promise<TUser | null> => {
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
      reviewStats,
    ] = await Promise.all([
        // KYC / provider doc
        Provider.findOne({ userId })
          .select(
            '-userId -rejectionReason -approvedAt -updatedAt -createdAt -__v'
          )
          .lean(),

        // All vehicles for this provider
        Vehicle.find({ userId: userObjectId, isDeleted: false })
          .select('name number year seats isDefault carPapers')
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

        Review.aggregate([
          { $match: { user: userObjectId } },
          {
            $group: {
              _id: null,
              sumRating: { $sum: '$rating' },
              count: { $sum: 1 },
            },
          },
        ]),
      ]);

    const liveTotalRating = reviewStats[0]?.count ?? 0;
    const liveAvgRating =
      liveTotalRating > 0
        ? Number((reviewStats[0].sumRating / liveTotalRating).toFixed(2))
        : 0;

    if (
      liveTotalRating > 0 &&
      (result.avgRating !== liveAvgRating || result.totalRating !== liveTotalRating)
    ) {
      result.avgRating = liveAvgRating;
      result.totalRating = liveTotalRating;
      await User.findByIdAndUpdate(userId, {
        $set: { avgRating: liveAvgRating, totalRating: liveTotalRating },
      }).catch(() => {});
    }

    providerData = provider;
    isKycSubmitted = !!provider;
    hasVehicle = vehicleList.length > 0;
    // Car papers are documents: only the admin and the driver may see them.
    const canSeeCarPapers =
      requester?.role === USER_ROLE.admin || requester?.userId === String(userId);
    vehicles = canSeeCarPapers
      ? vehicleList
      : vehicleList.map(({ carPapers: _papers, ...vehicle }: any) => vehicle);
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

  // Issue 27: drivers must be adults (riders only need a real, past date: see validation).
  const effectiveRole = payload.role || user.role;
  if (
    payload.dateOfBirth &&
    effectiveRole === USER_ROLE.provider &&
    !isAdultDriverDob(payload.dateOfBirth)
  ) {
    throw new ApiError(StatusCodes.BAD_REQUEST, DRIVER_TOO_YOUNG_MESSAGE);
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

  // Handle role selection or update
  if (payload.role && [USER_ROLE.user, USER_ROLE.provider].includes(payload.role as any)) {
    updateData.role = payload.role;
    if (payload.role === USER_ROLE.provider) {
      updateData.status = user.isKycVerified ? USER_STATUS.active : USER_STATUS.pending;
    } else {
      updateData.status = USER_STATUS.active;
    }
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

  const user = await User.findById(userId).select('_id status isDeleted').lean();
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found!');
  }

  const updateFields: Record<string, unknown> = { status };
  if (status === USER_STATUS.blocked) {
    updateFields.isOnline = false;
  }

  const selectFields = 'name fcmToken email phone status isDeleted isOnline';

  // Conditional update: only the request that actually flips the status gets a
  // document back. Retries / double-clicks / concurrent admin calls match
  // nothing here, so the user is notified exactly once per real change.
  const changed = await User.findOneAndUpdate(
    { _id: userId, status: { $ne: status } },
    updateFields,
    { returnDocument: 'after' },
  ).select(selectFields);

  const statusChanged = !!changed;
  const result =
    changed ||
    (await User.findByIdAndUpdate(userId, updateFields, {
      returnDocument: 'after',
    }).select(selectFields));
  if (!result) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  if (status === USER_STATUS.blocked) {
    try {
      const redis = getRedisClient();
      await Promise.all([
        redis.srem('users:online', userId),
        redis.srem('drivers:online', userId),
        redis.zrem('drivers:geo', userId),
        redis.zrem('drivers:location', userId),
        redis.del(`driver:${userId}:details`),
      ]);
    } catch {
      /* ignore redis cleanup errors */
    }
  }

  // Only notify when this call actually changed the status.
  if (statusChanged) {
    await sendUserStatusNotifYToUser(status, result);
  }

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

const ACTIVE_RIDE_STATUSES = [
  RIDE_STATUS.pending,
  RIDE_STATUS.accepted,
  RIDE_STATUS.started,
];

const ACTIVE_PASSENGER_STATUSES = [
  PASSENGER_STATUS.pending,
  PASSENGER_STATUS.split_matching,
  PASSENGER_STATUS.confirmed,
  PASSENGER_STATUS.driver_arrived,
  PASSENGER_STATUS.in_progress,
  PASSENGER_STATUS.picked_up,
];

const ON_BOARD_PASSENGER_STATUSES: string[] = [
  PASSENGER_STATUS.driver_arrived,
  PASSENGER_STATUS.in_progress,
  PASSENGER_STATUS.picked_up,
];

/**
 * Issue 30: an accepted ride the driver never started stays "accepted" forever
 * (see issue 13, report #2), so any old test ride blocked account deletion for
 * good. A ride now counts as active only while it is under way, or not yet past
 * the same window that hides it from Upcoming (departure + grace).
 */
export const isRideStillActive = (
  ride: { status?: string | null; departureDate?: unknown; departureTime?: unknown } | null | undefined,
  now: Date = new Date(),
): boolean => {
  if (!ride || !ACTIVE_RIDE_STATUSES.includes(ride.status as any)) return false;
  if (ride.status === RIDE_STATUS.started) return true;
  return !isPastUpcomingWindow(ride.departureDate, ride.departureTime, now);
};

const hasBlockingActiveRide = async (userId: string, now: Date = new Date()): Promise<boolean> => {
  const rideFields = 'status departureDate departureTime';

  const [rides, passengers, bookings] = await Promise.all([
    Ride.find({
      status: { $in: ACTIVE_RIDE_STATUSES },
      $or: [{ driverId: userId }, { rideCreatedBy: userId }],
    }).select(rideFields).lean(),
    Passenger.find({
      userId,
      status: { $in: ACTIVE_PASSENGER_STATUSES },
    }).select('status rideId departureDate departureTime').lean(),
    Booking.find({
      userId,
      bookingStatus: { $in: [BOOKING_STATUS.accepted, BOOKING_STATUS.running] },
    }).select('bookingStatus rideId').lean(),
  ]);

  if (rides.some((r: any) => isRideStillActive(r, now))) return true;
  if (passengers.some((p: any) => ON_BOARD_PASSENGER_STATUSES.includes(p.status))) return true;
  if (bookings.some((b: any) => b.bookingStatus === BOOKING_STATUS.running)) return true;

  // Remaining passengers/bookings are only active while their ride is.
  const rideIds = [
    ...passengers.map((p: any) => p.rideId),
    ...bookings.map((b: any) => b.rideId),
  ].filter(Boolean);
  const linkedRides = rideIds.length
    ? await Ride.find({ _id: { $in: rideIds } }).select(rideFields).lean()
    : [];
  const activeRideIds = new Set(
    linkedRides.filter((r: any) => isRideStillActive(r, now)).map((r: any) => String(r._id)),
  );

  if (passengers.some((p: any) =>
    p.rideId
      ? activeRideIds.has(String(p.rideId))
      // Split request still waiting for a match: active until its own departure window passes.
      : !isPastUpcomingWindow(p.departureDate, p.departureTime, now),
  )) return true;

  return bookings.some((b: any) => b.rideId && activeRideIds.has(String(b.rideId)));
};

const deleteUserProfile = async (
  targetUserId: string,
  requester: { userId: string; role: string },
  payload: { reason: string; otherReason?: string }
): Promise<TUser | null> => {
  const isAdmin = requester.role === USER_ROLE.admin;
  const userId = isAdmin ? targetUserId : requester.userId;

  if (!isAdmin && targetUserId !== requester.userId) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "You don't have permission to delete another user",
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);
    if (!user || user.isDeleted) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'User not found!');
    }

    if (await hasBlockingActiveRide(userId)) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        'Cannot delete profile while having an active ride',
      );
    }

    const uid = String(userId);
    const userObjectId = mongoose.Types.ObjectId.isValid(uid) ? new mongoose.Types.ObjectId(uid) : null;
    const userQuery = userObjectId ? { $in: [uid, userObjectId] } : uid;

    // Save deletion reason (fallback if not provided so transaction never aborts)
    await AccountDeletion.create(
      [
        {
          user: userObjectId || userId,
          reason: payload?.reason?.trim() ? payload.reason.trim() : 'User requested account deletion',
          otherReason: payload?.otherReason || '',
        },
      ],
      { session }
    );

    // Free the email and phone so the same credentials create a new user.
    const stamp = Date.now();
    const deletedUser = await User.findByIdAndUpdate(
      userId,
      {
        isDeleted: true,
        deletedAt: new Date(),
        email: `deleted.${uid}.${stamp}@example.com`,
        phone: `d${uid}${stamp}`,
        profileImage: null,
        address: null,
        type: null,
        isKycVerified: false,
        isProfileComplete: false,
        isOnline: false,
        documents: [],
        fcmToken: null,
        customerId: null,
        stripeAccountId: null,
        gender: null,
        dateOfBirth: null,
        experience: null,
        language: null,
        wallet: 0,
        avgRating: 0,
        totalRating: 0,
        isSignUpOtpVerified: false,
        isLoginOTPVerified: false,
        isResetPasswordVerified: false,
        status: user.role === USER_ROLE.provider ? 'pending' : 'active',
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

    // Remove related records (Provider KYC, Vehicles, Saved Places, Notifications)
    await Promise.all([
      Provider.deleteMany({ userId: userQuery }, { session }),
      Vehicle.deleteMany({ userId: userQuery }, { session }),
      UserLocation.deleteMany({ user: userQuery }, { session }),
      Notification.deleteMany({ receiver: userQuery }, { session }),
    ]);

    await session.commitTransaction();

    await Promise.all([
      deleteCache(REDIS_KEYS.SAVED_PLACES_BY_USER(uid)).catch(() => {}),
      deleteCache(REDIS_KEYS.VEHICLES_BY_USER(uid)).catch(() => {}),
      deleteCache(REDIS_KEYS.ACCOUNT_DELETION_ALL).catch(() => {}),
      deleteCachePattern('accountDeletion:*').catch(() => {}),
    ]);

    try {
      const redis = getRedisClient();
      await Promise.all([
        redis.srem('users:online', uid),
        redis.srem('drivers:online', uid),
        redis.zrem('drivers:location', uid),
        redis.zrem('drivers:geo', uid),
        redis.del(`driver:${uid}:details`),
        redis.del(`driver:${uid}:current`),
      ]);
    } catch {
      // ignore redis cleanup error
    }

    try {
      const activeSocket = onlineUsers[uid];
      if (activeSocket) {
        activeSocket.leave(`user:${uid}`);
        activeSocket.leave(`driver:${uid}`);
        delete onlineUsers[uid];
      }
      const io = getIO();
      io.in(`user:${uid}`).socketsLeave(`user:${uid}`);
      io.in(`driver:${uid}`).socketsLeave(`driver:${uid}`);
    } catch {
      // ignore socket cleanup error
    }

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




