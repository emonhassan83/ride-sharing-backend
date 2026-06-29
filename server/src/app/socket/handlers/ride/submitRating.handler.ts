// handlers/ride/submitRating.handler.ts
import { User } from '../../../modules/user/user.model';
import { Review } from '../../../modules/review/review.model';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { Booking } from '../../../modules/booking/booking.model';
import { BOOKING_STATUS } from '../../../modules/booking/booking.constant';
import { getRedisClient } from '../../../config/redis.config';
import { TSocket } from '../../interface/index.interface';
import { getIO } from '../../socket.init';
import eventHandler from '../../utils/eventHandler';
import { sendNotification } from '../../../utils/sentPushNotification';
import { modeType } from '../../../modules/notification/notification.interface';
import { RIDE_STATUS } from '../../../modules/ride/ride.constant';

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
        rating,
        comment: feedback || '',
      });

      // 6. Update Driver's Average Rating
      const driver = await User.findById(driverId);
      let newAvgRating = rating;

      if (driver) {
        const prevTotal = driver.totalRating || 0;
        const prevAvg = driver.avgRating || 0;
        const newTotal = prevTotal + 1;
        newAvgRating = Math.round(((prevAvg * prevTotal + rating) / newTotal) * 10) / 10;

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

      // 7. Real-time Socket Notification to Driver
      const io = getIO();
      io.to(`driver:${driverId}`).emit('ride:rating-received', {
        rideId,
        rating,
        feedback: feedback || '',
        newAverageRating: newAvgRating,
      });

      // 8. Push Notification to Driver (Mobile)
      const driverUser = await User.findById(driverId).select('fcmToken name').lean();
      if (driverUser?.fcmToken) {
        await sendNotification([driverUser.fcmToken], {
          receiver: driverId,
          message: '⭐ New Rating Received!',
          description: `${reviewerId ? 'A passenger' : 'Someone'} gave you ${rating} stars${feedback ? `: "${feedback}"` : ''}`,
          reference: rideId,
          modelType: modeType.Ride,
        }).catch((err) => console.warn('FCM failed for driver rating:', err));
      }

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