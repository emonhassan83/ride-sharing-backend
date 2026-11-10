import { StatusCodes } from 'http-status-codes';
import moment from 'moment';
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
    rideId: ride._id,
    status: {
      $in: [
        PASSENGER_STATUS.confirmed,
        PASSENGER_STATUS.driver_arrived,
        PASSENGER_STATUS.in_progress,
      ],
    },
  };
  if (passengerId) {
    passengerFilter._id = passengerId;
  }

  const passengers = await Passenger.find(passengerFilter).lean();
  if (!passengers.length) {
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      'No active confirmed passenger found for this ride.',
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
  }> = [];

  for (const passenger of passengers) {
    const pid = passenger._id.toString();
    const uid = passenger.userId.toString();
    const otp = String(generateOtp());

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
      .select('name email fcmToken')
      .lean();

    // 1. Real-time socket event to rider
    if (io) {
      io.to(`user:${uid}`).emit('ride:start-otp', {
        rideId: String(ride._id),
        passengerId: pid,
        otp,
        expiresInSeconds: RIDE_START_OTP_TTL_SECONDS,
        message: `Your ride start OTP is ${otp}. Share this code with your driver to start the trip.`,
      });
    }

    // 2. Push notification + in-app notification to rider
    await notifyUserPush({
      userId: uid,
      message: 'Ride Start OTP Code',
      description: `Your verification code to start the ride is ${otp}. Share this OTP with your driver when boarding.`,
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

    // 3. Email notification to rider
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
      expiresInSeconds: RIDE_START_OTP_TTL_SECONDS,
      ...(config.environment !== 'production' ? { otp } : {}),
    });
  }

  return {
    rideId: String(ride._id),
    expiresInSeconds: RIDE_START_OTP_TTL_SECONDS,
    passengers: results,
    ...(results.length === 1 ? { passengerId: results[0].passengerId } : {}),
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
    rideId: ride._id,
    status: {
      $in: [
        PASSENGER_STATUS.confirmed,
        PASSENGER_STATUS.driver_arrived,
        PASSENGER_STATUS.in_progress,
      ],
    },
  };
  if (passengerId) {
    passengerFilter._id = passengerId;
  }

  const passengers = await Passenger.find(passengerFilter);
  if (!passengers.length) {
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      'No active passenger found for OTP verification.',
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
    // Check if any OTP exists at all to distinguish expired vs invalid
    const anyOtpExists = await Promise.all(
      passengers.map((p) => redis.get(getRideStartOtpKey(rideId, p._id.toString()))),
    );
    const fallbackExists = await redis.get(getRideStartOtpFallbackKey(rideId));
    const hasActiveOtp = anyOtpExists.some(Boolean) || !!fallbackExists;

    if (!hasActiveOtp) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        'Ride start OTP has expired or was not requested. Please request a new OTP.',
      );
    }

    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Invalid ride start OTP. Please check the code with the passenger.',
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
    ...(passengers.length === 1
      ? [redis.del(getRideStartOtpFallbackKey(rideId))]
      : []),
  ]);

  try {
    const io = getIO();
    const eventPayload = {
      rideId: String(ride._id),
      passengerId: pid,
      isStartOtpVerified: true,
      message: 'Passenger OTP verified. Ride is now approved to start.',
    };
    io.to(`user:${uid}`).emit('ride:start-otp-verified', eventPayload);
    if (ride.driverId) {
      io.to(`driver:${ride.driverId.toString()}`).emit(
        'ride:start-otp-verified',
        eventPayload,
      );
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

