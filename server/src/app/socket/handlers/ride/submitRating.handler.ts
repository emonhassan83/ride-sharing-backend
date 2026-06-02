// handlers/ride/submitRating.handler.ts
import { User } from "../../../modules/user/user.model";
import { RiderHistory } from "../../../modules/riderHistory/riderHistory.model";
import { Review } from "../../../modules/review/review.model";
import { getRedisClient } from "../../../config/redis.config";
import { TSocket } from "../../interface/socket.interface";
import { getIO } from "../../socket.init";
import eventHandler from "../../utils/eventHandler";

/**
 * ride:submit-rating Handler
 * Rider rates the driver after trip completion
 * 
 * Emitted data from client:
 * { rideId, driverId, rating, feedback (optional) }
 */
export const submitRatingHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, driverId, rating, feedback } = data;
    const reviewerId = socket.auth?._id?.toString(); // Rider

    if (!rideId || !driverId || !rating) {
      return callback?.({ success: false, message: 'Missing required fields' });
    }
    if (rating < 1 || rating > 5) {
      return callback?.({ success: false, message: 'Rating must be between 1 and 5' });
    }

    try {
      // 1. যাচাই করুন এই রাইডটি রাইডার সম্পন্ন করেছেন এবং ইতিহাস বিদ্যমান
      const rideHistory = await RiderHistory.findOne({ rideId, userId: reviewerId });
      if (!rideHistory) {
        return callback?.({ success: false, message: 'Ride not found or unauthorized' });
      }

      // রাইডের স্ট্যাটাস 'completed' না হলে রেটিং নেওয়া ঠিক নয় (ঐচ্ছিক চেক)
      if (rideHistory.status !== 'completed') {
        return callback?.({ success: false, message: 'Cannot rate an incomplete ride' });
      }

      // 2. ডুপ্লিকেট রেটিং প্রতিরোধ – এই রাইডের জন্য এই রিভিউয়ার ইতিমধ্যে রেটিং দিয়েছে কিনা
      const existingReview = await Review.findOne({
        user: driverId,
        reviewer: reviewerId,
        ride: rideId,   // আপনার স্কিমা অনুযায়ী 'ride' বা 'rideId'
      });
      if (existingReview) {
        return callback?.({ success: false, message: 'You have already rated this ride' });
      }

      // 3. Review ডকুমেন্ট তৈরি করুন
      const review = await Review.create({
        user: driverId,
        reviewer: reviewerId,
        ride: rideId,
        rating,
        comment: feedback || '',
      });

      // 4. ❌ RiderHistory-তে rating সংরক্ষণ করা হবে না (যেহেতু স্কিমায় নেই)

      // 5. ড্রাইভারের রেটিং আপডেট করুন (MongoDB)
      const driver = await User.findById(driverId);
      if (!driver) {
        console.warn(`Driver ${driverId} not found, rating not updated`);
      } else {
        const totalRatings = (driver.totalRating || 0) + 1;
        const newAvgRating = ((driver.avgRating || 0) * (driver.totalRating || 0) + rating) / totalRatings;
        await User.findByIdAndUpdate(driverId, {
          avgRating: Math.round(newAvgRating * 10) / 10,
          totalRating: totalRatings,
        });
      }

      // 6. Redis-এ ড্রাইভারের রেটিং ক্যাশ আপডেট করুন (ম্যাচিংয়ে ব্যবহারের জন্য)
      const redis = getRedisClient();
      const driverDetails = await redis.hgetall(`driver:${driverId}:details`);
      if (driverDetails && Object.keys(driverDetails).length > 0) {
        await redis.hset(`driver:${driverId}:details`, 'rating', driver?.avgRating?.toString() || '0');
      }

      // 7. ড্রাইভারকে সকেট নোটিফিকেশন পাঠান
      const io = getIO();
      io.to(`driver:${driverId}`).emit('ride:rating-received', {
        rideId,
        rating,
        feedback: feedback || '',
        yourNewRating: driver?.avgRating || 0,
      });

      // 8. ক্লায়েন্টকে সাফল্য রেসপন্স
      callback?.({
        success: true,
        message: 'Thank you for your rating!',
        reviewId: review._id,
      });
    } catch (error) {
      console.error('Error in submitRatingHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);