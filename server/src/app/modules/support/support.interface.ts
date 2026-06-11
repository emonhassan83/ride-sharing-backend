import { Model, Types } from 'mongoose';
import { TContractBy, TSupportStatus } from './support.constant';

export interface TSupport {
  _id: Types.ObjectId;
  id: string
  user: Types.ObjectId;
  name: string
  phone: string
  email: string
  booking: Types.ObjectId;
  reason: string;
  contractBy: TContractBy
  status: TSupportStatus;
}

export type TSupportMessage = {
  _id?: string
  subject: string
  messages: string,
  contractBy: TContractBy
  status: TSupportStatus;
}

export type TSupportModel = Model<TSupport>;