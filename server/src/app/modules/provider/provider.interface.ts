import { Model, Types } from 'mongoose';
import { TProviderStatus } from './provider.constant';
import { TProviderType } from '../user/user.constant';

export interface TProvider {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: TProviderType
  companyName: string
  companyReg: string
  vatNumber: string
  ibanNumber: string
  cnicFront: string;
  cnicBack: string;
  licenseFront: string;
  licenseBack: string;
  carPapers: [string];
  status: TProviderStatus;
  rejectionReason: string
  approvedAt: Date
  createdAt: Date;
  updatedAt: Date;
}

export type TProviderModel = Model<TProvider>;

