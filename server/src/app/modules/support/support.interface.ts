import { Model, Types } from 'mongoose';
import { TSupportStatus } from './support.constant';

export interface TSupport {
  _id: Types.ObjectId;
  name: string
  phone: string
  email: string
  booking: Types.ObjectId;
  reason: string;
  status: TSupportStatus;
}

export type TSupportMessage = {
  _id?: string
  subject: string
  messages: string
}

export type TSupportModel = Model<TSupport>;