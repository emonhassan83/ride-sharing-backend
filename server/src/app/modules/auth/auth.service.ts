import moment from 'moment';
import ApiError from '../../errors/ApiError';
import { StatusCodes } from 'http-status-codes';
import { User } from '../user/user.model';
import bcrypt from 'bcrypt';
import { config } from '../../config/env.config';
import { REGISTER_WITH, USER_ROLE, USER_STATUS } from '../user/user.constant';
import {
  TAppleLoginPayload,
  TGoogleLoginPayload,
  TLoginWithEmail,
  TLoginWithPhone,
} from './auth.interface';
import {
  createToken,
  generateTokens,
  TExpiresIn,
  verifyToken,
} from './auth.utils';
import { generateOtp } from '../../utils/generateOtp';
import { OtpRedisService } from '../../redis/helpers/otp';
import twilio from 'twilio';
import jwt, { Secret } from 'jsonwebtoken';
import { getEmailQueueInstance } from '../../utils/queueHelper';

const OTP_EXPIRE = 60 * 5; // 5 minutes in seconds

const createUser = async (payload: any) => {
  const { email, phone, fcmToken, ...rest } = payload;

  // Prevent users from assigning themselves admin role during registration
  if (payload.role === USER_ROLE.admin) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      'You cannot directly assign admin role'
    );
  }

  // 1. check existing user via email and phone
  const existingUser = await User.findOne({
    $or: [{ email }, { phone }],
  });

  if (existingUser) {
    // Check if user existing
    if (!existingUser.isDeleted && existingUser.isSignUpOtpVerified) {
      // Sent exact error message in user
      const message = existingUser.email === email
        ? 'User already exists with this email'
        : 'User already exists with this phone number';

      throw new ApiError(StatusCodes.FORBIDDEN, message);
    }

    // 2. Soft deleted user — recreate
    if (existingUser.isDeleted) {
      existingUser.set({ ...payload, isDeleted: false });
      const user = await existingUser.save();
      return user;
    }

    // 3. Unverified user — update fields and re-save
    if (!existingUser.isSignUpOtpVerified) {
      existingUser.set({ ...payload });
      const user = await existingUser.save();
      return user;
    }
  }

  const finalPayload = {
    ...rest,
    email,
    phone,
    fcmToken,
    status:
      payload.role === USER_ROLE.provider
        ? USER_STATUS.pending
        : payload.status || USER_STATUS.active,
  };

  const user = await User.create(finalPayload);
  if (!user) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'User creation failed');
  }

  return user;
};

const registerWithGoogle = async (payload: TGoogleLoginPayload) => {
  if (payload.role === 'admin') {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      'You cannot directly assign admin role'
    );
  }

  const user = await User.isExistUserByEmail(payload.email as string);

  const updateData: any = {
    name: payload.name,
    email: payload.email,
    photoUrl: payload.photoUrl,
    fcmToken: payload.fcmToken,
  };

  if (user) {
    if (user.registerWith !== REGISTER_WITH.google) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        `This account is registered with ${user.registerWith}, please use that method.`
      );
    }

    if (user.isDeleted) {
      const updatedUser = await User.findByIdAndUpdate(
        user._id,
        {
          ...updateData,
          isDeleted: false,
          verification: { otp: 0, expiresAt: new Date(), status: true },
          expireAt: null,
        },
        { returnDocument: 'after' }
      );

      if (!updatedUser) {
        throw new ApiError(
          StatusCodes.INTERNAL_SERVER_ERROR,
          'Failed to reactivate deleted user.'
        );
      }

      return generateTokens(updatedUser as any);
    }

    await User.findByIdAndUpdate(user._id, updateData, { returnDocument: 'after' });
    return generateTokens(user as any);
  }

  // ================== NEW USER CREATION ==================
  const isProvider = payload.role === USER_ROLE.provider;

  const newUser = await User.create({
    ...updateData,
    role: payload.role,
    registerWith: REGISTER_WITH.google,
    verification: { otp: 0, expiresAt: new Date(), status: true },
    expireAt: null,
    status: isProvider ? USER_STATUS.pending : USER_STATUS.active, // ← Key Change
  });

  if (!newUser) {
    throw new ApiError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      'Failed to create user!'
    );
  }

  return generateTokens(newUser);
};

const registerWithApple = async (payload: TAppleLoginPayload) => {
  if (payload.role === 'admin') {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      'You cannot directly assign admin role'
    );
  }

  const user = await User.isExistUserByEmail(payload.email as string);

  const updateData: any = {
    name: payload.name,
    email: payload.email,
    photoUrl: payload.photoUrl,
    fcmToken: payload.fcmToken,
  };

  if (user) {
    if (user.registerWith !== REGISTER_WITH.apple) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        `This account is registered with ${user.registerWith}, please use that method.`
      );
    }

    if (user.isDeleted) {
      const updatedUser = await User.findByIdAndUpdate(
        user._id,
        {
          ...updateData,
          isDeleted: false,
          verification: { otp: 0, expiresAt: new Date(), status: true },
          expireAt: null,
        },
        { returnDocument: 'after' }
      );

      if (!updatedUser) {
        throw new ApiError(
          StatusCodes.INTERNAL_SERVER_ERROR,
          'Failed to reactivate deleted user.'
        );
      }

      return generateTokens(updatedUser);
    }

    await User.findByIdAndUpdate(user._id, updateData, { returnDocument: 'after' });
    return generateTokens(user as any);
  }

  // ================== NEW USER CREATION ==================
  const isProvider = payload.role === USER_ROLE.provider;

  const newUser = await User.create({
    ...updateData,
    role: payload.role,
    registerWith: REGISTER_WITH.apple,
    verification: { otp: 0, expiresAt: new Date(), status: true },
    expireAt: null,
    status: isProvider ? USER_STATUS.pending : USER_STATUS.active, // ← Key Change
  });

  if (!newUser) {
    throw new ApiError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      'Failed to create user!'
    );
  }

  return generateTokens(newUser);
};

const loginWithEmail = async (payload: TLoginWithEmail) => {
  const { email, password, fcmToken } = payload as TLoginWithEmail;

  //* checking if the user is exist
  const user = await User.findOne({ email }).select('+password');
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'This user is not found !');
  }

  //* checking if the password is correct
  if (!(await User.isMatchPassword(password, user?.password)))
    throw new ApiError(StatusCodes.FORBIDDEN, 'Password do not matched');

  // if user is not verify yet throw error
  if (!user?.isSignUpOtpVerified) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'Your profile is not verified');
  }

  // CHECK USER PROFILE ACTIVE
  // if (user.status !== USER_STATUS.active) {
  //   throw new ApiError(
  //     StatusCodes.FORBIDDEN,
  //      'Your account is not active yet. Please wait for admin approval.',
  //   )
  // }

  //* create token and sent to the  client
  const jwtPayload = {
    userId: user._id!,
    email: user.email!,
    role: user.role!,
  };

  const accessToken = createToken(
    jwtPayload,
    config.jwt.accessSecret as string,
    config.jwt.accessExpiration as TExpiresIn
  );

  const refreshToken = createToken(
    jwtPayload,
    config.jwt.refreshSecret as string,
    config.jwt.refreshExpiration as TExpiresIn
  );

  //* 5. Prepare update object for FCM + location
  const updateData: any = {};

  if (fcmToken) {
    updateData.fcmToken = fcmToken;
  }

  //* 6. Update user document if needed
  if (Object.keys(updateData).length > 0) {
    await User.findByIdAndUpdate(user._id, updateData, { returnDocument: 'after' });
  }

  return {
    accessToken,
    refreshToken,
    user: {
      name: user.name,
      email: user.email,
      role: user.role,
      isProfileComplete: user.isProfileComplete,
      status: user.status,
      registerWith: user.registerWith,
    },
  };
};

const loginWithPhone = async (payload: TLoginWithPhone) => {
  const { phone, fcmToken } = payload as TLoginWithPhone;

  //* checking if the user is exist
  const user = await User.findOne({ phone });
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'This user is not found ! Please check your phone and country code');
  }

  // if user is not verify yet throw error
  if (!user?.isSignUpOtpVerified) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'Your profile is not verified');
  }

  // CHECK USER PROFILE ACTIVE
  // if (user.status !== USER_STATUS.active) {
  //   throw new ApiError(
  //     StatusCodes.FORBIDDEN,
  //      'Your account is not active yet. Please wait for admin approval.',
  //   )
  // }

  // Prepare update object for FCM + location
  const updateData: any = {};

  if (fcmToken) {
    updateData.fcmToken = fcmToken;
  }

  //* Update user document if needed
  if (Object.keys(updateData).length > 0) {
    await User.findByIdAndUpdate(
      user._id,
      { isLoginOTPVerified: false, ...updateData },
      { returnDocument: 'after' }
    );
  }

  const otp = generateOtp();
  const hashedOtp = await bcrypt.hash(otp.toString(), 10);

  // Redis এ OTP সেভ করা
  await OtpRedisService.saveOtp(user.email, hashedOtp, OTP_EXPIRE);
  const expiresAt = moment().add(5, 'minute');

  const jwtPayload = {
    userId: user?._id,
    email: user?.email,
    role: user?.role,
  };
  const token = jwt.sign(jwtPayload, config.jwt.accessSecret as Secret, {
    expiresIn: '5m',
  });

  // === মক মোড চেক করা ===
  const isDevelopment = config.environment !== 'production';

  if (isDevelopment) {
    console.log('🔑 [MOCK OTP] Phone:', phone);
    console.log('🔑 [MOCK OTP] Code:', otp);
    console.log(
      '🔑 [MOCK OTP] Expires at:',
      expiresAt.format('YYYY-MM-DD HH:mm:ss')
    );
    console.log('⚠️  Real SMS skipped in development mode');

    // টেস্টের জন্য OTP রিটার্ন করছি (প্রোডাকশনে এটা রিমুভ করবেন)
    return {
      verificationToken: token,
      otp,
      mock: true,
    };
  }

  // === প্রোডাকশন মোড: রিয়েল Twilio SMS ===
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);

  try {
    const res = await client.messages.create({
      body: `Welcome to Split Ride, your verification code is ${otp}. It expires in 5 minutes. Please do not sharing.`,
      from: config.twilio.phoneNumber,
      to: phone,
    });
    console.log(res);

    return {
      verificationToken: token,
    };
  } catch (error: any) {
    console.error('Twilio SMS Error:', error);
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to send OTP');
  }
};

const forgotPassword = async (payload: { email: string }) => {
  const { email } = payload;

  //* checking if the user is exist
  const user = await User.isExistUserByEmail(email);
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'This user is not found !');
  }

  //* create token and sent to the  client
  const jwtPayload = {
    userId: user._id!,
    email: user.email!,
    role: user.role!,
  };

  const resetToken = createToken(
    jwtPayload,
    config.jwt.accessSecret as string,
    '5m'
  );

  const otp = generateOtp();
  const hashedOtp = await bcrypt.hash(otp.toString(), 10);

  // Save to Redis
  await OtpRedisService.saveOtp(email, hashedOtp, OTP_EXPIRE);

  const expiresAt = moment().add(5, 'minute');

  // Get queue instance and add job
  const emailQueue = await getEmailQueueInstance();

  await emailQueue.add(
    'send-reset-password-email',
    {
      email: user.email,
      name: user.name,
      otp,
      expiresAt: expiresAt.format('LT'),
    },
    {
      priority: 1,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    }
  );

  await User.findByIdAndUpdate(
    user._id,
    { isResetPasswordVerified: false },
    { returnDocument: 'after' }
  );

  return { resetPasswordToken: resetToken };
};

const resetPassword = async (
  userId: string,
  payload: {
    password: string;
    confirmPassword: string;
  }
) => {
  const { password, confirmPassword } = payload;

  if (password !== confirmPassword) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Password and Confirm Password not matched.'
    );
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  // checked if is allow to changed password or not
  if (!user?.isResetPasswordVerified) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      'Please complete OTP verification to reset your password.'
    );
  }

  //* hash new password
  const newHashedPassword = await bcrypt.hash(
    payload.password,
    Number(config.bcrypt.saltRounds)
  );

  const passwordResetUser = await User.findOneAndUpdate(
    {
      _id: user._id,
    },
    {
      $set: {
        password: newHashedPassword,
        passwordChangedAt: new Date(),
      },
    },
    { returnDocument: 'after' }
  );

  //if password is not updated throw error
  if (!passwordResetUser) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      'Password was not reset. Please try again!'
    );
  }
};

const changePassword = async (
  userId: string,
  payload: { oldPassword: string; newPassword: string }
) => {
  //* checking if the user is exist
  const user = await User.findById(userId);
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'This user is not found !');
  }

  //* checking if the password is correct
  if (!(await User.isMatchPassword(payload.oldPassword, user?.password)))
    throw new ApiError(StatusCodes.FORBIDDEN, 'Password do not matched');

  //* hash new password
  const newHashedPassword = await bcrypt.hash(
    payload.newPassword,
    Number(config.bcrypt.saltRounds)
  );

  const updateUserPassword = await User.findOneAndUpdate(
    {
      _id: user._id,
      role: user.role,
    },
    {
      $set: {
        password: newHashedPassword,
        needsPasswordChange: false,
        passwordChangedAt: new Date(),
      },
    },
    { returnDocument: 'after' }
  );

  //if password is not updated throw error
  if (!updateUserPassword) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      'Password was not updated. Please try again!'
    );
  }

  return null;
};

const logoutUser = async (userId: string) => {
  //* checking if the user is exist
  const user = await User.findById(userId);
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'This user is not found !');
  }

  // set user login boolean field
  await User.findByIdAndUpdate(
    userId,
    { isLoginOTPVerified: false },
    { returnDocument: 'after' }
  );

  return null;
};

const refreshToken = async (token: string) => {
  //* checking if the given token is valid
  const decoded = verifyToken(token, config.jwt.accessSecret as string);

  //* checking if the user is exist
  const user = await User.isExistUserByEmail(decoded?.email);
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'This user is not found !');
  }

  const jwtPayload = {
    userId: user._id!,
    email: user.email!,
    role: user.role!,
  };

  const accessToken = createToken(
    jwtPayload,
    config.jwt.accessSecret as string,
    config.jwt.accessExpiration as TExpiresIn
  );

  return {
    accessToken,
  };
};

export const AuthService = {
  createUser,
  loginWithEmail,
  loginWithPhone,
  registerWithGoogle,
  registerWithApple,
  resetPassword,
  forgotPassword,
  logoutUser,
  changePassword,
  refreshToken,
};
