import { Model, Types } from 'mongoose';

export interface TReviews {
  user: Types.ObjectId;
  reviewer: Types.ObjectId;
  ride: Types.ObjectId;
  rating: number;
  comment: string;
  createdAt: Date;
  updatedAt: Date;
}

export type TReviewsModules = Model<TReviews, Record<string, unknown>>
