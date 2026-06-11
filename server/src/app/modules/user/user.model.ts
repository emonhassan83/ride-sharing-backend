import { model, Schema } from 'mongoose';
import { TUser, UserModal } from './user.interface';
import bcrypt from 'bcrypt';
import { config } from '../../config/env.config';
import { GENDER, REGISTER_WITH, USER_ROLE, USER_STATUS } from './user.constant';

// User Schema Definition
const userSchema = new Schema<TUser, UserModal>(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        'Please provide a valid email address',
      ],
    },
    password: {
      type: String,
      select: false,
      null: true,
      minlength: [8, 'Password must be at least 8 characters long'],
    },
    fcmToken: {
      type: String,
      default: null,
    },
    role: {
      type: String,
      enum: Object.values(USER_ROLE),
      required: [true, 'Role is required'],
    },
    profileImage: {
      type: String,
      default: null,
    },
    documents: {
      type: [String],
      default: [],
    },
    phone: {
      type: String,
      required: false,
    },
    countryCode: {
      type: String,
      default: null,
    },
    address: { type: String, required: false },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0],
      },
    },
    timeZone: { type: String, default: 'UTC' },
    dateOfBirth: { type: String, required: false },
    gender: { type: String, enum: Object.values(GENDER), required: false },
    registerWith: {
      type: String,
      enum: Object.values(REGISTER_WITH),
      default: REGISTER_WITH.credentials,
    },
    wallet: {
      type: Number,
      default: 0.0,
    },
    language: { type: String, default: null },
    experience: { type: String, default: null },

    // verification fields
    status: {
      type: String,
      enum: Object.values(USER_STATUS),
      default: USER_STATUS.active,
    },
    isSignUpOtpVerified: {
      type: Boolean,
      default: false,
    },
    isLoginOTPVerified: {
      type: Boolean,
      default: false,
    },
    isResetPasswordVerified: {
      type: Boolean,
      default: false,
    },
    isChangeEmailOtpVerified: {
      type: Boolean,
      default: false,
    },
    isChangePhoneOtpVerified: {
      type: Boolean,
      default: false,
    },
    isProfileComplete: {
      type: Boolean,
      default: false,
    },
    isKycVerified: {
      type: Boolean,
      default: false,
    },
    lastPasswordChange: { type: Date },
    stripeAccountId: { type: String, default: null },
    customerId: { type: String, default: null },
    isOnline: { type: Boolean, default: false },
    lastOnlineAt: { type: Date, default: null },

    // others
    avgRating: {
      type: Number,
      default: 0,
    },
    totalRating: {
      type: Number,
      default: 0,
    },
    expireAt: { type: Date, default: () => new Date(Date.now() + 30 * 60000) },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toObject: { virtuals: true },
  }
);

// Static methods
userSchema.statics.isExistUserById = async function (id: string) {
  return await this.findById(id);
};

userSchema.statics.isExistUserByEmail = async function (email: string) {
  return await this.findOne({ email });
};

userSchema.statics.isMatchPassword = async function (
  password: string,
  hashPassword: string
): Promise<boolean> {
  return await bcrypt.compare(password, hashPassword);
};

// Middleware to hash password before saving
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return; // only hash if password is modified or new

  if (!this.password) return; // prevents Google crash

  this.password = await bcrypt.hash(
    this.password,
    Number(config.bcrypt.saltRounds)
  );
});

// for location and auto expire inactive users
userSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
userSchema.index({ location: '2dsphere' });

// Export the User model
export const User = model<TUser, UserModal>('User', userSchema);
