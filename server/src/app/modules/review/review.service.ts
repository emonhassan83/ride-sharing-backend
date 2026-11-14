import mongoose, { ClientSession, startSession } from 'mongoose';
import { TReviews } from './review.interface';
import { User } from '../user/user.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { Review } from './review.model';
import ApiError from '../../errors/ApiError';
import { StatusCodes } from 'http-status-codes';
import { USER_ROLE } from '../user/user.constant';
import { getCache, setCache, deleteCache, deleteCachePattern } from '../../redis/helpers';
import { REDIS_KEYS } from '../../redis/keys';
import { getIO } from '../../socket/socket.init';
import { getRedisClient } from '../../config/redis.config';

const REVIEWS_TTL = 60 * 5;

// ==================== CREATE REVIEW ====================
const createReviews = async (payload: TReviews, userId: string) => {
  const session: ClientSession = await startSession();
  session.startTransaction();

  try {
    const reviewer = await User.findById(userId).session(session).lean();
    if (!reviewer || reviewer.isDeleted)
      throw new ApiError(StatusCodes.NOT_FOUND, 'User not found or deleted!');

    const [newReview] = await Review.create(
      [{ ...payload, comment: payload.comment || '', reviewer: reviewer._id }],
      { session },
    );
    if (!newReview)
      throw new ApiError(StatusCodes.BAD_REQUEST, 'Failed to create review');

    const reviewedUserId = new mongoose.Types.ObjectId(String(payload.user));
    const driverId = reviewedUserId.toString();

    const ratingStats = await Review.aggregate([
      { $match: { user: reviewedUserId } },
      {
        $group: {
          _id: null,
          totalRating: { $sum: '$rating' },
          count: { $sum: 1 },
        },
      },
    ]).session(session);

    const { totalRating = 0, count = 0 } = ratingStats[0] || {};
    const newAvgRating = count > 0 ? Number((totalRating / count).toFixed(2)) : 0;

    await User.findOneAndUpdate(
      {
        _id: reviewedUserId,
        role: USER_ROLE.provider,
        isDeleted: false,
      },
      {
        $set: {
          avgRating: newAvgRating,
          totalRating: count,
        },
      },
      { session, returnDocument: 'after' },
    );

    await session.commitTransaction();
    session.endSession();

    // ✅ Invalidate cache for reviews of this user
    await Promise.all([
      deleteCache(REDIS_KEYS.REVIEWS_BY_USER(driverId)),
      deleteCache(REDIS_KEYS.REVIEWS_ALL),
      deleteCachePattern('reviews:*'),
    ]);

    try {
      const redis = getRedisClient();
      const cacheKey = `driver:${driverId}:details`;
      if (await redis.exists(cacheKey)) {
        await redis.hset(cacheKey, {
          rating: newAvgRating.toString(),
          avgRating: newAvgRating.toString(),
          totalRating: count.toString(),
        });
      }
    } catch {
      /* ignore redis error */
    }

    try {
      const io = getIO();
      const ratingPayload = {
        rideId: payload.ride ? String(payload.ride) : null,
        reviewId: String(newReview._id),
        driverId,
        reviewerId: String(reviewer._id),
        rating: Number(payload.rating),
        feedback: payload.comment || '',
        comment: payload.comment || '',
        newAverageRating: newAvgRating,
        averageRating: newAvgRating,
        avgRating: newAvgRating,
        totalRating: count,
        totalRatings: count,
        ratingCount: count,
        totalReviews: count,
      };
      io.to(`driver:${driverId}`).emit('ride:rating-received', ratingPayload);
      io.to(`user:${driverId}`).emit('ride:rating-received', ratingPayload);
    } catch {
      /* ignore socket error */
    }

    return {
      ...(newReview.toObject ? newReview.toObject() : newReview),
      avgRating: newAvgRating,
      newAverageRating: newAvgRating,
      totalRating: count,
      ratingCount: count,
    };
  } catch (error: any) {
    await session.abortTransaction();
    session.endSession();
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      error?.message || 'Review creation failed',
    );
  }
};

// ==================== GET ALL REVIEWS ====================
const getAllReviews = async (query: Record<string, any>) => {
  const userIdFilter = query?.user ? String(query.user) : 'all';
  const pageKey = `${query?.page || 1}:${query?.limit || 10}`;
  const cacheKey =
    userIdFilter !== 'all'
      ? `${REDIS_KEYS.REVIEWS_BY_USER(userIdFilter)}:${pageKey}`
      : `${REDIS_KEYS.REVIEWS_ALL}:${pageKey}`;

  // 1. Try cache
  const cached = await getCache<any>(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit for reviews`);
    return cached;
  }

  console.log(`📡 Cache miss for reviews, fetching from DB...`);

  const baseFilter: Record<string, any> = {};
  if (query?.user && mongoose.Types.ObjectId.isValid(String(query.user))) {
    baseFilter.user = new mongoose.Types.ObjectId(String(query.user));
  }

  const queryCopy = { ...query };
  delete queryCopy.user;

  const reviewsModel = new QueryBuilder(
    Review.find(baseFilter)
      .populate([{ path: 'reviewer', select: 'name profileImage role' }])
      .select('reviewer comment rating ride createdAt'),
    queryCopy
  )
    .search([''])
    .filter()
    .paginate()
    .fields();

  const data = await reviewsModel.modelQuery;
  const meta = await reviewsModel.countTotal();

  const [ratingBreakdown, overallStats] = await Promise.all([
    Review.aggregate([
      {
        $match: baseFilter,
      },
      {
        $group: {
          _id: '$rating',
          count: { $sum: 1 },
        },
      },
    ]),
    Review.aggregate([
      {
        $match: baseFilter,
      },
      {
        $group: {
          _id: null,
          sumRating: { $sum: '$rating' },
          totalRating: { $sum: 1 },
        },
      },
    ]),
  ]);

  const countMap = {
    excellent: 0,
    veryGood: 0,
    good: 0,
    fair: 0,
    poor: 0,
  };

  ratingBreakdown.forEach((item) => {
    const rating = item._id;
    if (rating === 5) countMap.excellent = item.count;
    else if (rating === 4) countMap.veryGood = item.count;
    else if (rating === 3) countMap.good = item.count;
    else if (rating === 2) countMap.fair = item.count;
    else if (rating === 1) countMap.poor = item.count;
  });

  const totalRating = overallStats[0]?.totalRating ?? 0;
  const avgRating =
    totalRating > 0
      ? Number((overallStats[0].sumRating / totalRating).toFixed(2))
      : 0;

  const result = {
    meta,
    data: {
      avgRating,
      averageRating: avgRating,
      totalRating,
      ratingCount: totalRating,
      ratingBreakdown: countMap,
      reviews: data,
    },
  };

  // 2. Set cache with TTL
  await setCache(cacheKey, result, REVIEWS_TTL);

  return result;
};

export const ReviewsService = {
  createReviews,
  getAllReviews,
};