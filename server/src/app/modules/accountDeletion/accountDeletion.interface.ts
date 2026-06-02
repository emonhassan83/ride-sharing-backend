import { Model, Types } from 'mongoose';

export interface IAccountDeletion {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  reason: string;
  otherReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type TAccountDeletionModel = Model<IAccountDeletion>;