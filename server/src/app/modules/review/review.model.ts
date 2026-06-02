import mongoose, { Schema } from 'mongoose';
import { TReviews, TReviewsModules } from './review.interface';

const reviewSchema = new Schema<TReviews>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ride: { type: Schema.Types.ObjectId, ref: 'Ride', required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, required: true },
  },
  {
    timestamps: true,
  }
);

export const Review = mongoose.model<TReviews, TReviewsModules>('Review', reviewSchema);
