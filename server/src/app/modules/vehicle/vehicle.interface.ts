import { Model, Types } from 'mongoose';

export interface TVehicle {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  number: string;
  year: number;
  seats: number;
  isDefault: boolean;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type TVehicleModel = Model<TVehicle>;