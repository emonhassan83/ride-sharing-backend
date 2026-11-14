// handlers/ride/submitRating.handler.ts
import mongoose from 'mongoose';
import { User } from '../../../modules/user/user.model';
import { Review } from '../../../modules/review/review.model';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { getRedisClient } from '../../../config/redis.config';
import { deleteCache, deleteCachePattern } from '../../../redis/helpers';
import { REDIS_KEYS } from '../../../redis/keys';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { sendNotification } from '../../../utils/sentPushNotification';
import { modeType } from '../../../modules/notification/notification.interface';
import { RIDE_STATUS } from '../../../modules/ride/ride.constant';

export const submitRatingHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, rating, feedback, comment } = data || {};
    const numericRating = Number(rating);
    const reviewComment = (feedback ?? comment ?? '').toString().trim() || 'Rated ride';
    const reviewerId = socket.auth?._id?.toString(); // Passenger who is rating

    // ─── Validation ──────────────────────────────────────────────────
    if (!rideId || !Number.isFinite(numericRating)) {
      return callback?.({ success: false, message: 'rideId and rating are required' });
    }
    if (numericRating < 1 || numericRating > 5) {
      return callback?.({ success: false, message: 'Rating must be between 1 and 5' });
    }
    if (!reviewerId) {
      return callback?.({ success: false, message: 'Unauthorized' });
    }

    try {
      // 1. Get Ride details
      const ride = await Ride.findById(rideId)
        .select('driverId rideCreatedBy status')
        .lean();

      if (!ride) {
        return callback?.({ success: false, message: 'Ride not found' });
      }
      if (!ride.driverId) {
        return callback?.({ success: false, message: 'No driver assigned to this ride' });
      }

      const driverId = ride.driverId.toString();
      const driverObjectId = new mongoose.Types.ObjectId(driverId);

      // 2. Verify reviewer is a valid passenger
      const passengerRecord = await Passenger.findOne({
        rideId,
        userId: reviewerId,
      }).lean();

      if (!passengerRecord) {
        return callback?.({ success: false, message: 'You are not a passenger of this ride' });
      }

      // 3. Check if ride is completed
      if (ride.status !== RIDE_STATUS.completed) {
        const reviewerBooking = await Booking.findOne({
          passengerId: passengerRecord._id,
          bookingStatus: BOOKING_STATUS.completed,
        }).lean();

        if (!reviewerBooking) {
          return callback?.({ success: false, message: 'You can only rate completed rides' });
        }
      }

      // 4. Prevent duplicate review
      const existingReview = await Review.findOne({
        user: driverId,
        reviewer: reviewerId,
        ride: rideId,
      }).lean();

      if (existingReview) {
        return callback?.({ success: false, message: 'You have already rated this ride' });
      }

      // 5. Create Review
      const review = await Review.create({
        user: driverId,
        reviewer: reviewerId,
        ride: rideId,
        rating: numericRating,
        comment: reviewComment,
      });

      // 6. Recalculate Driver's Exact Average Rating & Total Rating Count from Review collection
      const [ratingStats, ratingBreakdownAgg] = await Promise.all([
        Review.aggregate([
          { $match: { user: driverObjectId } },
          {
            $group: {
              _id: null,
              sumRating: { $sum: '$rating' },
              count: { $sum: 1 },
            },
          },
        ]),
        Review.aggregate([
          { $match: { user: driverObjectId } },
          {
            $group: {
              _id: '$rating',
              count: { $sum: 1 },
            },
          },
        ]),
      ]);

      const totalRatingCount = ratingStats[0]?.count ?? 1;
      const sumRating = ratingStats[0]?.sumRating ?? numericRating;
      const newAvgRating = Number((sumRating / totalRatingCount).toFixed(2));

      const ratingBreakdown = {
        excellent: 0,
        veryGood: 0,
        good: 0,
        fair: 0,
        poor: 0,
      };
      ratingBreakdownAgg.forEach((item) => {
        if (item._id === 5) ratingBreakdown.excellent = item.count;
        else if (item._id === 4) ratingBreakdown.veryGood = item.count;
        else if (item._id === 3) ratingBreakdown.good = item.count;
        else if (item._id === 2) ratingBreakdown.fair = item.count;
        else if (item._id === 1) ratingBreakdown.poor = item.count;
      });

      await User.findByIdAndUpdate(driverId, {
        $set: {
          avgRating: newAvgRating,
          totalRating: totalRatingCount,
        },
      });

      // Update Redis cache & invalidate stale review cache
      const redis = getRedisClient();
      const cacheKey = `driver:${driverId}:details`;
      if (await redis.exists(cacheKey)) {
        await redis.hset(cacheKey, {
          rating: newAvgRating.toString(),
          avgRating: newAvgRating.toString(),
          totalRating: totalRatingCount.toString(),
        });
      }
      await Promise.all([
        deleteCache(REDIS_KEYS.REVIEWS_ALL),
        deleteCache(REDIS_KEYS.REVIEWS_BY_USER(driverId)),
        deleteCachePattern('reviews:*'),
      ]);

      // 7. Real-time Socket Notification to Driver (both driver & user rooms) with complete rating stats
      const ratingPayload = {
        rideId: String(rideId),
        reviewId: String(review._id),
        driverId,
        reviewerId,
        rating: numericRating,
        feedback: feedback ?? comment ?? '',
        comment: reviewComment,
        newAverageRating: newAvgRating,
        averageRating: newAvgRating,
        avgRating: newAvgRating,
        totalRating: totalRatingCount,
        totalRatings: totalRatingCount,
        ratingCount: totalRatingCount,
        totalReviews: totalRatingCount,
        ratingBreakdown,
      };

      const io = getIO();
      io.to(`driver:${driverId}`).emit('ride:rating-received', ratingPayload);
      io.to(`user:${driverId}`).emit('ride:rating-received', ratingPayload);

      // 8. Push Notification to Driver (Mobile)
      const driverUser = await User.findById(driverId).select('fcmToken name').lean();
      if (driverUser?.fcmToken) {
        await sendNotification([driverUser.fcmToken], {
          receiver: driverId,
          message: '⭐ New Rating Received!',
          description: `${reviewerId ? 'A passenger' : 'Someone'} gave you ${numericRating} stars${feedback ? `: "${feedback}"` : ''}`,
          reference: rideId,
          modelType: modeType.Ride,
        }).catch((err) => console.warn('FCM failed for driver rating:', err));
      }

      callback?.({
        success: true,
        message: 'Thank you for your feedback!',
        reviewId: review._id,
        data: ratingPayload,
      });

    } catch (error: any) {
      console.error('❌ Error in submitRatingHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);