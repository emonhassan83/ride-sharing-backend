import bcrypt from 'bcrypt';
import { StatusCodes } from 'http-status-codes';
import jwt, { JwtPayload, Secret } from 'jsonwebtoken';
import moment from 'moment';
import ApiError from '../../errors/ApiError';
import { config } from '../../config/env.config';
import { User } from '../user/user.model';
import { createToken, TExpiresIn } from '../auth/auth.utils';
import { generateOtp } from '../../utils/generateOtp';
import twilio from 'twilio';
import { OtpRedisService } from '../../redis/helpers/otp';
import { getEmailQueueInstance } from '../../utils/queueHelper';
import { USER_ROLE } from '../user/user.constant';
import { Provider } from '../provider/provider.model';
import { Vehicle } from '../vehicle/vehicle.model';

const OTP_EXPIRE = 60 * 5; // 5 minutes in seconds

const verifyOTP = async (
  tokenWithBearer: string,
  otp: string | number,
  query: Record<string, unknown>
) => {
  const { type } = query;

  const token = tokenWithBearer.split(' ')[1];
  if (!token) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'You are not authorized');
  }

  let decode: JwtPayload;
  try {
    decode = jwt.verify(token, config.jwt.accessSecret as Secret) as JwtPayload;
  } catch (err) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      'Session has expired. Please request a new OTP.'
    );
  }

  const email = decode.email;
  if (!email) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Email is required');
  }

  // Verify OTP from Redis
  const storedHash = await OtpRedisService.getOtp(email);
  if (!storedHash) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      'OTP has expired. Please resend it'
    );
  }

  const isMatch = await bcrypt.compare(otp.toString(), storedHash);
  if (!isMatch) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Invalid OTP');
  }

  // Delete OTP after successful verification
  await OtpRedisService.deleteOtp(email);

  let updateData: Record<string, any> = {};
  let responseData: any = {};

  switch (type) {
    case 'signup':
      updateData = { isSignUpOtpVerified: true, expireAt: null };
      break;

    case 'forgot':
      updateData = { isResetPasswordVerified: true };
      break;

    case 'login':
      updateData = { isLoginOTPVerified: true };
      break;

    case 'changeEmail':
      updateData = { isChangeEmailOtpVerified: true };
      responseData.isChangeEmailOtpVerified = true;
      break;

    case 'changePhone':
      updateData = { isChangePhoneOtpVerified: true };
      responseData.isChangePhoneOtpVerified = true;
      break;

    default:
      throw new ApiError(StatusCodes.BAD_REQUEST, 'Invalid OTP type');
  }

  const user = await User.findOneAndUpdate(
    { email },
    { $set: updateData },
    { new: true }
  );

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  // ==================== LOGIN, SIGNUP, FORGOT → Return Tokens ====================
  if (['login', 'signup', 'forgot'].includes(type)) {
    const jwtPayload = {
      userId: user._id,
      email: user.email,
      role: user.role,
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

    let isKycSubmitted = false;
    let hasVehicle = false;

    if (user.role === USER_ROLE.provider) {
      const provider = await Provider.findOne({ userId: user._id });
      
      isKycSubmitted = !!provider;

      const vehicle = await Vehicle.findOne({ userId: user._id });
      hasVehicle = !!vehicle;
    }

    return {
      message: `OTP verified for ${type}`,
      data: {
        accessToken,
        refreshToken,
        user: {
          name: user.name,
          email: user.email,
          role: user.role,
          isProfileComplete: user.isProfileComplete,
          status: user.status,
          isKycSubmitted,
          hasVehicle,
        },
      },
    };
  }

  // ==================== Change Email / Phone → Return Flag ====================
  return { message: `OTP verified for ${type}`, data: responseData };
};

const sendOtpInEmail = async (userId: string, email: string) => {
  const user = await User.findById(userId);
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'User not found');
  }

  const otp = generateOtp();
  const hashedOtp = await bcrypt.hash(otp.toString(), 10);

  // Save to Redis
  await OtpRedisService.saveOtp(user.email, hashedOtp, OTP_EXPIRE);

  const expiresAt = moment().add(5, 'minute');

  // Get queue instance and add job
  const emailQueue = await getEmailQueueInstance();

  await emailQueue.add(
    'send-verification-email',
    {
      email: email,
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

  // Generate token
  const jwtPayload = { email: user.email, userId: user._id };
  const token = jwt.sign(jwtPayload, config.jwt.accessSecret as Secret, {
    expiresIn: '5m',
  });

  return { verificationToken: token };
};

const sendOtpViaTokenInPhone = async (
  userId: string,
  payload: { phone: string }
) => {
  const { phone } = payload;

  const user = await User.findById(userId);
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'User not found');
  }

  const otp = generateOtp();
  const hashedOtp = await bcrypt.hash(otp.toString(), 10);

  // Save OTP in redis
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

  // === Mock mode check ===
  const isDevelopment = config.environment !== 'production';

  if (isDevelopment) {
    console.log('🔑 [MOCK OTP] Phone:', phone);
    console.log('🔑 [MOCK OTP] Code:', otp);
    console.log(
      '🔑 [MOCK OTP] Expires at:',
      expiresAt.format('YYYY-MM-DD HH:mm:ss')
    );
    console.log('⚠️  Real SMS skipped in development mode');

    // For testing mock data generate
    return {
      verificationToken: token,
      otp,
      mock: true,
    };
  }

  // === Production Mode: Twilio SMS ===
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

const sendOtpViaDirectPhone = async (payload: { phone: string }) => {
  const { phone } = payload;

  const user = await User.findOne({ phone });
  if (!user || user?.isDeleted) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'User not found');
  }

  const otp = generateOtp();
  const hashedOtp = await bcrypt.hash(otp.toString(), 10);

  // === Save OTP redis ===
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

  // === Mock mode check ===
  const isDevelopment = config.environment !== 'production';

  if (isDevelopment) {
    console.log('🔑 [MOCK OTP] Phone:', phone);
    console.log('🔑 [MOCK OTP] Code:', otp);
    console.log(
      '🔑 [MOCK OTP] Expires at:',
      expiresAt.format('YYYY-MM-DD HH:mm:ss')
    );
    console.log('⚠️  Real SMS skipped in development mode');

    // For testing mock data generate
    return {
      token,
      otp,
      mock: true,
    };
  }

  // === Production Mode: Twilio SMS ===
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);

  try {
    const res = await client.messages.create({
      body: `Your verification code is ${otp}. It expires in 5 minutes. Please do not sharing.`,
      from: config.twilio.phoneNumber,
      to: phone,
    });
    console.log(res);

    return {
      token,
    };
  } catch (error: any) {
    console.error('Twilio SMS Error:', error);
    throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to send OTP');
  }
};

export const otpServices = {
  verifyOTP,
  sendOtpInEmail,
  sendOtpViaTokenInPhone,
  sendOtpViaDirectPhone,
};
