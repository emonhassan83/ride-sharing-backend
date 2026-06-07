// handlers/ride/submitRating.handler.ts
import { User } from '../../../modules/user/user.model';
import { Review } from '../../../modules/review/review.model';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { getRedisClient } from '../../../config/redis.config';
import { TSocket } from '../../interface/socket.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';

/**
 * ride:submit-rating Handler
 * Client Payload: { rideId, rating, feedback? }
 */
export const submitRatingHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, rating, feedback } = data;
    const reviewerId = socket.auth?._id?.toString(); // Passenger who is rating

    // ─── Validation ──────────────────────────────────────────────────
    if (!rideId || !rating) {
      return callback?.({ success: false, message: 'rideId and rating are required' });
    }
    if (rating < 1 || rating > 5) {
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

      // 2. Verify reviewer is a valid passenger of this ride
      const passengerRecord = await Passenger.findOne({
        rideId,
        userId: reviewerId,
      }).lean();

      if (!passengerRecord) {
        return callback?.({ success: false, message: 'You are not a passenger of this ride' });
      }

      // 3. Check if ride is completed
      if (ride.status !== 'completed') {
        return callback?.({ success: false, message: 'You can only rate completed rides' });
      }

      // 4. Prevent duplicate review
      const existingReview = await Review.findOne({
        user: driverId,           // Driver being reviewed
        reviewer: reviewerId,     // Passenger giving rating
        ride: rideId,
      }).lean();

      if (existingReview) {
        return callback?.({ success: false, message: 'You have already rated this ride' });
      }

      // 5. Create Review
      const review = await Review.create({
        user: driverId,           // Driver (being reviewed)
        reviewer: reviewerId,     // Passenger (reviewer)
        ride: rideId,
        rating,
        comment: feedback || '',
      });

      // 6. Update Driver's Average Rating
      const driver = await User.findById(driverId);
      if (driver) {
        const prevTotal = driver.totalRating || 0;
        const prevAvg = driver.avgRating || 0;
        const newTotal = prevTotal + 1;
        const newAvgRating = Math.round(((prevAvg * prevTotal + rating) / newTotal) * 10) / 10;

        await User.findByIdAndUpdate(driverId, {
          avgRating: newAvgRating,
          totalRating: newTotal,
        });

        // Update Redis cache
        const redis = getRedisClient();
        const cacheKey = `driver:${driverId}:details`;
        if (await redis.exists(cacheKey)) {
          await redis.hset(cacheKey, 'rating', newAvgRating.toString());
        }
      }

      // 7. Notify Driver in real-time
      const io = getIO();
      io.to(`driver:${driverId}`).emit('ride:rating-received', {
        rideId,
        rating,
        feedback: feedback || '',
        newAverageRating: driver?.avgRating,
      });

      callback?.({
        success: true,
        message: 'Thank you for your feedback!',
        reviewId: review._id,
      });

    } catch (error: any) {
      console.error('❌ Error in submitRatingHandler:', error);
      callback?.({ success: false, message: 'Internal server error' });
    }
  }
);