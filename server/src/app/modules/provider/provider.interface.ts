import { Model, Types } from 'mongoose';
import { TProviderStatus } from './provider.constant';

export interface TProvider {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  companyName: string
  companyReg: string
  vatNumber: string
  socialInsurance: string
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