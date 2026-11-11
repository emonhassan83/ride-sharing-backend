import { StatusCodes } from 'http-status-codes';
import moment from 'moment';
import twilio from 'twilio';
import ApiError from '../errors/ApiError';
import { getRedisClient } from '../config/redis.config';
import { config } from '../config/env.config';
import { Ride } from '../modules/ride/ride.model';
import { RIDE_STATUS } from '../modules/ride/ride.constant';
import { Passenger } from '../modules/passenger/passenger.model';
import { PASSENGER_STATUS } from '../modules/passenger/passenger.constant';
import { User } from '../modules/user/user.model';
import { USER_ROLE } from '../modules/user/user.constant';
import { generateOtp } from './generateOtp';
import { getEmailQueueInstance } from './queueHelper';
import { notifyUserPush } from './notifyUser.utils';
import { modeType } from '../modules/notification/notification.interface';
import { getIO } from '../socket/socket.init';

const RIDE_START_OTP_TTL_SECONDS = 10 * 60; // 10 minutes
const RIDE_START_VERIFIED_TTL_SECONDS = 2 * 60 * 60; // 2 hours

export const getRideStartOtpKey = (rideId: string, passengerId: string) =>
  `ride:start:otp:${rideId}:${passengerId}`;

export const getRideStartOtpFallbackKey = (rideId: string) =>
  `ride:start:otp:${rideId}`;

export const getRideStartVerifiedKey = (rideId: string, passengerId: string) =>
  `ride:start:verified:${rideId}:${passengerId}`;

export const isPassengerStartOtpVerified = async (
  rideId: string,
  passengerId: string,
  passengerDoc?: any,
): Promise<boolean> => {
  if (passengerDoc?.isStartOtpVerified) return true;
  const redis = getRedisClient();
  const cached = await redis.get(getRideStartVerifiedKey(rideId, passengerId));
  if (cached === 'true') return true;
  const fresh = await Passenger.findById(passengerId)
    .select('isStartOtpVerified')
    .lean();
  return !!fresh?.isStartOtpVerified;
};

export const sendRideStartOtp = async (params: {
  rideId: string;
  passengerId?: string;
  requesterId?: string;
  requesterRole?: string;
}) => {
  const { rideId, passengerId, requesterId, requesterRole } = params;
  if (!rideId) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'rideId is required');
  }

  if (!passengerId) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'passengerId is required to send ride start OTP.',
    );
  }

  const ride = await Ride.findById(rideId).lean();
  if (!ride) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');
  }

  if (
    ride.status === RIDE_STATUS.cancelled ||
    ride.status === RIDE_STATUS.rejected ||
    ride.status === RIDE_STATUS.completed
  ) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      `Cannot send start OTP for a ${ride.status} ride.`,
    );
  }

  if (
    requesterRole === USER_ROLE.provider &&
    requesterId &&
    ride.driverId &&
    ride.driverId.toString() !== requesterId
  ) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      'You are not the assigned driver for this ride.',
    );
  }

  const passengerFilter: Record<string, any> = {
    _id: passengerId,
    rideId: ride._id,
    status: {
      $in: [
        PASSENGER_STATUS.confirmed,
        PASSENGER_STATUS.driver_arrived,
        PASSENGER_STATUS.in_progress,
      ],
    },
  };

  const passengers = await Passenger.find(passengerFilter).lean();
  if (!passengers.length) {
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      'No active confirmed passenger found for this ride with the provided passengerId.',
    );
  }

  const redis = getRedisClient();
  let io: any = null;
  try {
    io = getIO();
  } catch {
    /* socket may not be initialized in worker context */
  }

  const results: Array<{
    passengerId: string;
    userId: string;
    expiresInSeconds: number;
    otp?: string;
    phone?: string;
  }> = [];

  for (const passenger of passengers) {
    const pid = passenger._id.toString();
    const uid = passenger.userId.toString();
    // Guaranteed 6-digit OTP
    const otp = String(generateOtp()).padStart(6, '0');

    await Promise.all([
      redis.setex(
        getRideStartOtpKey(rideId, pid),
        RIDE_START_OTP_TTL_SECONDS,
        otp,
      ),
      redis.setex(
        getRideStartOtpFallbackKey(rideId),
        RIDE_START_OTP_TTL_SECONDS,
        otp,
      ),
    ]);

    const riderUser = await User.findById(uid)
      .select('name email phone fcmToken')
      .lean();

    // 1. Real-time socket events to passenger listener (ensuring passenger receives it)
    if (io) {
      const otpSocketPayload = {
        rideId: String(ride._id),
        passengerId: pid,
        otp,
        expiresInSeconds: RIDE_START_OTP_TTL_SECONDS,
        message: `Your ride start OTP is ${otp}. Share this code with your driver when boarding.`,
      };
      io.to(`user:${uid}`).emit('ride:start-otp', otpSocketPayload);
      io.to(`passenger:${pid}`).emit('ride:start-otp', otpSocketPayload);
      io.to(`user:${uid}`).emit('passenger:start-otp', otpSocketPayload);
      io.to(`user:${uid}`).emit('driver:send-start-otp', otpSocketPayload);
    }

    // 2. Direct Phone SMS via Twilio (same pattern as sendOtpViaDirectPhone)
    if (riderUser?.phone) {
      const isDevelopment = config.environment !== 'production';
      if (isDevelopment) {
        console.log(`🔑 [RIDE START OTP] Passenger Phone: ${riderUser.phone}`);
        console.log(`🔑 [RIDE START OTP] 6-digit Code: ${otp}`);
        console.log('⚠️  Real SMS skipped in development mode');
      } else if (
        config.twilio?.accountSid &&
        config.twilio?.authToken &&
        config.twilio?.phoneNumber
      ) {
        try {
          const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
          await twilioClient.messages.create({
            body: `Your ride start OTP is ${otp}. It expires in 10 minutes. Please share this 6-digit code with your driver when boarding.`,
            from: config.twilio.phoneNumber,
            to: riderUser.phone,
          });
        } catch (twilioErr: any) {
          console.error(`Twilio SMS failed for passenger phone ${riderUser.phone}:`, twilioErr);
        }
      }
    }

    // 3. Push notification + in-app notification to rider
    await notifyUserPush({
      userId: uid,
      message: 'Ride Start OTP Code',
      description: `Your 6-digit verification code to start the ride is ${otp}. Share this OTP with your driver when boarding.`,
      reference: String(ride._id),
      modelType: modeType.Ride,
      data: {
        type: 'RIDE_START_OTP',
        rideId: String(ride._id),
        passengerId: pid,
        otp,
      },
    }).catch((err) => {
      console.warn(`Failed to send ride start OTP push to ${uid}:`, err);
    });

    // 4. Email notification to rider
    if (riderUser?.email) {
      try {
        const expiresAt = moment().add(10, 'minute');
        const emailQueue = await getEmailQueueInstance();
        await emailQueue.add(
          'send-verification-email',
          {
            email: riderUser.email,
            name: riderUser.name || 'Rider',
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
          },
        );
      } catch (emailErr) {
        console.warn(`Failed to queue ride start OTP email for ${riderUser.email}:`, emailErr);
      }
    }

    results.push({
      passengerId: pid,
      userId: uid,
      phone: riderUser?.phone || '',
      expiresInSeconds: RIDE_START_OTP_TTL_SECONDS,
      ...(config.environment !== 'production' ? { otp } : {}),
    });
  }

  return {
    rideId: String(ride._id),
    passengerId: results[0]?.passengerId || passengerId,
    expiresInSeconds: RIDE_START_OTP_TTL_SECONDS,
    passengers: results,
    ...(config.environment !== 'production' && results[0]?.otp
      ? { otp: results[0].otp, mock: true }
      : {}),
  };
};

export const verifyRideStartOtp = async (params: {
  rideId: string;
  otp: string | number;
  passengerId?: string;
  requesterId?: string;
  requesterRole?: string;
}) => {
  const { rideId, otp, passengerId, requesterId, requesterRole } = params;
  const submittedOtp = String(otp ?? '').trim();

  if (!rideId || !submittedOtp) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'rideId and otp are required to authorize ride start.',
    );
  }

  if (!passengerId) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'passengerId is required to verify OTP.',
    );
  }

  const ride = await Ride.findById(rideId).lean();
  if (!ride) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');
  }

  if (
    requesterRole === USER_ROLE.provider &&
    requesterId &&
    ride.driverId &&
    ride.driverId.toString() !== requesterId
  ) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      'You are not the assigned driver for this ride.',
    );
  }

  const passengerFilter: Record<string, any> = {
    _id: passengerId,
    rideId: ride._id,
    status: {
      $in: [
        PASSENGER_STATUS.confirmed,
        PASSENGER_STATUS.driver_arrived,
        PASSENGER_STATUS.in_progress,
      ],
    },
  };

  const passengers = await Passenger.find(passengerFilter);
  if (!passengers.length) {
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      'No active passenger found for OTP verification with the provided passengerId.',
    );
  }

  const redis = getRedisClient();
  let matchedPassenger: any = null;

  for (const p of passengers) {
    const pid = p._id.toString();
    const storedForPassenger = await redis.get(getRideStartOtpKey(rideId, pid));
    if (storedForPassenger && storedForPassenger.trim() === submittedOtp) {
      matchedPassenger = p;
      break;
    }
  }

  if (!matchedPassenger && passengers.length === 1) {
    const fallbackStored = await redis.get(getRideStartOtpFallbackKey(rideId));
    if (fallbackStored && fallbackStored.trim() === submittedOtp) {
      matchedPassenger = passengers[0];
    }
  }

  if (!matchedPassenger) {
    const storedOtp = await redis.get(getRideStartOtpKey(rideId, passengerId));
    const fallbackExists = await redis.get(getRideStartOtpFallbackKey(rideId));
    const hasActiveOtp = !!storedOtp || !!fallbackExists;

    if (!hasActiveOtp) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        'Ride start OTP has expired or was not requested. Please request a new OTP.',
      );
    }

    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Invalid ride start OTP. Please check the 6-digit code with the passenger.',
    );
  }

  const pid = matchedPassenger._id.toString();
  const uid = matchedPassenger.userId.toString();

  matchedPassenger.isStartOtpVerified = true;
  await matchedPassenger.save();

  await Promise.all([
    redis.setex(
      getRideStartVerifiedKey(rideId, pid),
      RIDE_START_VERIFIED_TTL_SECONDS,
      'true',
    ),
    redis.del(getRideStartOtpKey(rideId, pid)),
    redis.del(getRideStartOtpFallbackKey(rideId)),
  ]);

  try {
    const io = getIO();
    const eventPayload = {
      rideId: String(ride._id),
      passengerId: pid,
      userId: uid,
      isStartOtpVerified: true,
      message: 'Passenger OTP verified. Ride is now approved to start.',
    };

    // Both sides: passenger socket rooms
    io.to(`user:${uid}`).emit('ride:start-otp-verified', eventPayload);
    io.to(`passenger:${pid}`).emit('ride:start-otp-verified', eventPayload);
    io.to(`user:${uid}`).emit('driver:verify-start-otp', eventPayload);
    io.to(`user:${uid}`).emit('driver:start-otp-verified', eventPayload);

    // Both sides: driver socket rooms
    if (ride.driverId) {
      const did = ride.driverId.toString();
      io.to(`driver:${did}`).emit('ride:start-otp-verified', eventPayload);
      io.to(`user:${did}`).emit('ride:start-otp-verified', eventPayload);
      io.to(`driver:${did}`).emit('driver:verify-start-otp', eventPayload);
      io.to(`driver:${did}`).emit('driver:start-otp-verified', eventPayload);
    }
  } catch {
    /* ignore socket error */
  }

  return {
    rideId: String(ride._id),
    passengerId: pid,
    isStartOtpVerified: true,
  };
};

