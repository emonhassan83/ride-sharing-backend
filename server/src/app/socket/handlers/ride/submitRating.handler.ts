// handlers/ride/submitRating.handler.ts
import { User } from '../../../modules/user/user.model';
import { RiderHistory } from '../../../modules/riderHistory/riderHistory.model';
import { Review } from '../../../modules/review/review.model';
import { Ride } from '../../../modules/ride/ride.model';
import { getRedisClient } from '../../../config/redis.config';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

/**
 * ride:submit-rating Handler
 *
 * Client payload:
 * { rideId, rating, feedback? }
 *
 * driverId is resolved from the Ride document — client doesn't need to send it.
 */
export const submitRatingHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, rating, feedback } = data;
    const reviewerId = socket.auth?._id?.toString();

    // ─── Validation ──────────────────────────────────────────────────
    if (!rideId || !rating) {
      return callback?.({ success: false, message: 'rideId and rating are required' });
    }
    if (rating < 1 || rating > 5) {
      return callback?.({ success: false, message: 'Rating must be between 1 and 5' });
    }

    try {
      // ─── 1. Get driverId from Ride document ───────────────────────
      const ride = await Ride.findById(rideId).select('driverId status').lean();
      if (!ride) {
        return callback?.({ success: false, message: 'Ride not found' });
      }
      if (!ride.driverId) {
        return callback?.({ success: false, message: 'No driver assigned to this ride' });
      }

      const driverId = ride.driverId.toString();

      // ─── 2. Verify rider completed this ride ──────────────────────
      const rideHistory = await RiderHistory.findOne({
        rideId,
        userId: reviewerId,
      }).lean();

      if (!rideHistory) {
        return callback?.({ success: false, message: 'Ride not found or unauthorized' });
      }
      if (rideHistory.status !== 'completed') {
        return callback?.({ success: false, message: 'Cannot rate an incomplete ride' });
      }

      // ─── 3. Prevent duplicate rating ─────────────────────────────
      const existingReview = await Review.findOne({
        user:     driverId,
        reviewer: reviewerId,
        ride:     rideId,
      }).lean();

      if (existingReview) {
        return callback?.({ success: false, message: 'You have already rated this ride' });
      }

      // ─── 4. Create Review ─────────────────────────────────────────
      const review = await Review.create({
        user:     driverId,
        reviewer: reviewerId,
        ride:     rideId,
        rating,
        comment:  feedback || '',
      });

      // ─── 5. Update driver's average rating in DB ──────────────────
      const driver = await User.findById(driverId);
      let newAvgRating = rating;

      if (driver) {
        const prevTotal  = driver.totalRating || 0;
        const prevAvg    = driver.avgRating   || 0;
        const newTotal   = prevTotal + 1;
        newAvgRating     = Math.round(((prevAvg * prevTotal + rating) / newTotal) * 10) / 10;

        await User.findByIdAndUpdate(driverId, {
          avgRating:   newAvgRating,
          totalRating: newTotal,
        });

        // ─── 6. Update driver rating in Redis cache ────────────────
        const redis = getRedisClient();
        const driverCacheExists = await redis.exists(`driver:${driverId}:details`);
        if (driverCacheExists) {
          await redis.hset(`driver:${driverId}:details`, 'rating', newAvgRating.toString());
        }
      }

      // ─── 7. Notify driver via socket ──────────────────────────────
      const io = getIO();
      io.to(`driver:${driverId}`).emit('ride:rating-received', {
        rideId,
        rating,
        feedback:     feedback || '',
        yourNewRating: newAvgRating,
      });

      callback?.({
        success:  true,
        message:  'Thank you for your rating!',
        reviewId: review._id,
      });

    } catch (error) {
      console.error('❌ Error in submitRatingHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  },
);