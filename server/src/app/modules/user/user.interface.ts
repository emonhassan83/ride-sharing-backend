import { Model, Types } from 'mongoose';
import { PaginateOptions, PaginateResult } from '../../types/paginate';
import { TGender, TUserRole, TUserStatus } from './user.constant';

export type TGeoLocation = {
  type: 'Point';
  coordinates: [number, number]; // [longitude, latitude]
};

export type TUser = {
  _id: Types.ObjectId;
  sid: string;
  name: string;
  email: string;
  password: string;
  fcmToken: string
  role: TUserRole;
  profileImage: string;
  documents: string[];
  phone: string;
  countryCode?: string
  address: string;
  location: TGeoLocation | null;
  timeZone: string;
  dateOfBirth: string;
  gender: TGender;
  registerWith: string 
  wallet: number;
  language: string
  experience: string

  // verification fields
  isSignUpOtpVerified: boolean;
  isLoginOTPVerified: boolean;
  isResetPasswordVerified: boolean;
  isProfileComplete: boolean;
  isKycVerified: boolean
  isChangeEmailOtpVerified: boolean
  isChangePhoneOtpVerified: boolean
  lastPasswordChange: Date;
  stripeAccountId: string
  customerId: string
  status: TUserStatus;
  expireAt: Date
  isOnline: boolean
  lastOnlineAt: Date

  avgRating: number,
  totalRating: number,
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export interface UserModal extends Model<TUser> {
  paginate: (
    filter: object,
    options: PaginateOptions
  ) => Promise<PaginateResult<TUser>>;
  isExistUserById(id: string): Promise<Partial<TUser> | null>;
  isExistUserByEmail(email: string): Promise<Partial<TUser> | null>;
  isMatchPassword(password: string, hashPassword: string): Promise<boolean>;
}
``