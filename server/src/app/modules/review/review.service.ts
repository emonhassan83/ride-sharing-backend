import mongoose, { ClientSession, startSession } from 'mongoose';
import { TReviews } from './review.interface';
import { User } from '../user/user.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { Review } from './review.model';
import ApiError from '../../errors/ApiError';
import { StatusCodes } from 'http-status-codes';
import { USER_ROLE, USER_STATUS } from '../user/user.constant';
import { getCache, setCache, deleteCache } from '../../redis/helpers';
import { REDIS_KEYS } from '../../redis/keys';

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
      [{ ...payload, reviewer: reviewer._id }],
      { session },
    );
    if (!newReview)
      throw new ApiError(StatusCodes.BAD_REQUEST, 'Failed to create review');

    const reviewedUserId = new mongoose.Types.ObjectId(String(payload.user));

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
    const newAvgRating = count > 0 ? totalRating / count : 0;

    await User.findOneAndUpdate(
      {
        _id: reviewedUserId,
        role: USER_ROLE.provider,
        status: USER_STATUS.active,
        isDeleted: false,
      },
      {
        $set: {
          avgRating: Number(newAvgRating.toFixed(2)),
          totalRating: count,
        },
      },
      { session, returnDocument: 'after' },
    );

    await session.commitTransaction();
    session.endSession();

    // ✅ Invalidate cache for reviews of this user
    await deleteCache(REDIS_KEYS.REVIEWS_BY_USER(reviewedUserId.toString()));

    return newReview;
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
  const cacheKey = REDIS_KEYS.REVIEWS_ALL;

  // 1. Try cache
  const cached = await getCache<any>(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit for reviews`);
    return cached;
  }

  console.log(`📡 Cache miss for reviews, fetching from DB...`);

  const reviewsModel = new QueryBuilder(
    Review.find()
      .populate([{ path: 'reviewer', select: 'name profileImage role' }])
      .select('reviewer review rating createdAt'),
    query
  )
    .search([''])
    .filter()
    .paginate()
    .fields();

  const data = await reviewsModel.modelQuery;
  const meta = await reviewsModel.countTotal();

  const ratingBreakdown = await Review.aggregate([
    {
      $match: reviewsModel.modelQuery.getFilter(),
    },
    {
      $group: {
        _id: '$rating',
        count: { $sum: 1 },
      },
    },
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

  const result = {
    meta,
    data: {
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