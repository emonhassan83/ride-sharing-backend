// handlers/ride/ratePassenger.handler.ts
// The driver's "Rate your passenger" screen. Mirror of ride:submit-rating:
// the review is stored with user = rider, reviewer = driver.
import mongoose from 'mongoose';
import { User } from '../../../modules/user/user.model';
import { Review } from '../../../modules/review/review.model';
import { Ride } from '../../../modules/ride/ride.model';
import { Passenger } from '../../../modules/passenger/passenger.model';
import { PASSENGER_STATUS } from '../../../modules/passenger/passenger.constant';
import { deleteCache, deleteCachePattern } from '../../../redis/helpers';
import { REDIS_KEYS } from '../../../redis/keys';
import { TSocket } from '../../interface/index.interface';
import eventHandler from '../../utils/eventHandler';

// The driver may rate once the rider is off the car, even if the trip itself
// (other split riders) is still running.
const RATEABLE_PASSENGER_STATUSES = [
  PASSENGER_STATUS.dropped_off,
  PASSENGER_STATUS.completed,
];

export const ratePassengerHandler = eventHandler<any>(
  async (socket: TSocket, data: any, callback?: any) => {
    const { rideId, passengerId, rating, comment, feedback } = data || {};
    const numericRating = Number(rating);
    const driverId = socket.auth?._id?.toString();

    if (!driverId) {
      return callback?.({ success: false, code: 'UNAUTHORIZED', message: 'Unauthorized' });
    }
    if (!rideId || !Number.isFinite(numericRating)) {
      return callback?.({
        success: false,
        code: 'MISSING_FIELDS',
        message: 'rideId and rating are required',
      });
    }
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      return callback?.({
        success: false,
        code: 'INVALID_RATING',
        message: 'Rating must be between 1 and 5',
      });
    }
    if (
      !mongoose.Types.ObjectId.isValid(String(rideId)) ||
      (passengerId && !mongoose.Types.ObjectId.isValid(String(passengerId)))
    ) {
      return callback?.({ success: false, code: 'INVALID_VALUE', message: 'Invalid ride or passenger id' });
    }

    const ride = await Ride.findById(rideId).select('driverId').lean();
    if (!ride) {
      return callback?.({ success: false, code: 'RIDE_NOT_FOUND', message: 'Ride not found' });
    }
    if (ride.driverId?.toString() !== driverId) {
      return callback?.({
        success: false,
        code: 'NOT_ASSIGNED_DRIVER',
        message: 'You are not assigned to this ride',
      });
    }

    // passengerId is optional only when the ride has exactly one rateable rider (private ride).
    const passengers = await Passenger.find({
      rideId,
      ...(passengerId ? { _id: passengerId } : {}),
    })
      .select('_id userId status')
      .lean();

    if (!passengers.length) {
      return callback?.({
        success: false,
        code: 'PASSENGER_NOT_FOUND',
        message: 'Passenger not found on this ride',
      });
    }
    if (!passengerId && passengers.length > 1) {
      return callback?.({
        success: false,
        code: 'MISSING_FIELDS',
        message: 'passengerId is required for a ride with several passengers',
      });
    }

    const passenger: any = passengers[0];
    if (!RATEABLE_PASSENGER_STATUSES.includes(passenger.status)) {
      return callback?.({
        success: false,
        code: 'TRIP_NOT_FINISHED',
        message: 'You can rate a passenger only after the trip',
      });
    }

    const riderId = passenger.userId.toString();
    const riderObjectId = new mongoose.Types.ObjectId(riderId);

    const existing = await Review.findOne({
      user: riderId,
      reviewer: driverId,
      ride: rideId,
    }).lean();
    if (existing) {
      return callback?.({
        success: false,
        code: 'ALREADY_RATED',
        message: 'You have already rated this passenger',
      });
    }

    const review = await Review.create({
      user: riderId,
      reviewer: driverId,
      ride: rideId,
      rating: numericRating,
      comment: (comment ?? feedback ?? '').toString().trim(),
    });

    const [stats] = await Review.aggregate([
      { $match: { user: riderObjectId } },
      { $group: { _id: null, sumRating: { $sum: '$rating' }, count: { $sum: 1 } } },
    ]);
    const totalRating = stats?.count ?? 1;
    const avgRating = Number(((stats?.sumRating ?? numericRating) / totalRating).toFixed(2));

    await User.findByIdAndUpdate(riderId, { $set: { avgRating, totalRating } });

    await Promise.all([
      deleteCache(REDIS_KEYS.REVIEWS_ALL),
      deleteCache(REDIS_KEYS.REVIEWS_BY_USER(riderId)),
      deleteCachePattern('reviews:*'),
    ]).catch(() => {});

    return callback?.({
      success: true,
      message: 'Thank you for your feedback!',
      data: {
        reviewId: review._id,
        rideId: String(rideId),
        passengerId: String(passenger._id),
        rating: numericRating,
      },
    });
  },
);
