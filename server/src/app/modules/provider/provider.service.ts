import mongoose, { startSession } from 'mongoose';
import ApiError from '../../errors/ApiError';
import { StatusCodes } from 'http-status-codes';
import { User } from '../user/user.model';
import { USER_STATUS } from '../user/user.constant';
import { PROVIDER_STATUS, TProviderStatus } from './provider.constant';
import { Provider } from './provider.model';
import QueryBuilder from '../../builder/QueryBuilder';
import { TProvider } from './provider.interface';
import { sendKycStatusNotification } from './provider.utils';
import { getEmailQueueInstance } from '../../utils/queueHelper';

// Create a new Verification
const insertIntoDB = async (userId: string, payload: TProvider) => {
  const session = await startSession();

  try {
    await session.startTransaction();

    // Validate user
    const user = await User.findById(userId).session(session);
    if (!user || user?.isDeleted) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
    }

    // Check if verification already exists
    const existingOne = await Provider.findOne({
      user: user._id,
    }).session(session);

    if (existingOne) {
      throw new ApiError(
        StatusCodes.CONFLICT,
        'User already sent KYC verification!'
      );
    }

    // Assign into payload
    payload.userId = user._id;

    // Create verification record
    const [verification] = await Provider.create([payload], { session });

    if (!verification) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        'Verification creation failed'
      );
    }

    // Commit transaction
    await session.commitTransaction();

    return verification;
  } catch (error: any) {
    await session.abortTransaction();
    throw error instanceof ApiError
      ? error
      : new ApiError(
          StatusCodes.INTERNAL_SERVER_ERROR,
          error.message || 'Verification creation failed'
        );
  } finally {
    session.endSession();
  }
};

// Get all Verification
const getAllIntoDB = async (query: Record<string, any>) => {
  const verificationModel = new QueryBuilder(
    Provider.find().populate([{ path: 'user', select: 'name email phone' }]),
    query
  )
    .search([''])
    .filter()
    .paginate()
    .sort()
    .fields();

  const data = await verificationModel.modelQuery;
  const meta = await verificationModel.countTotal();
  return {
    data,
    meta,
  };
};

// Get Verification by ID
const getAIntoDB = async (id: string) => {
  const result = await Provider.findById(id).populate([
    { path: 'userId', select: 'name email phone profileImage isKycVerified' },
  ]);
  if (!result) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'Oops! Verification not found');
  }

  return result;
};

const updateStatusIntoDB = async (
  id: string,
  payload: { status: TProviderStatus; rejectionReason?: string }
) => {
  const { status, rejectionReason } = payload;

  const provider = await Provider.findById(id);
  if (!provider) {
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      'Provider verification not found!'
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let updatedVerification: any;

    if (status === PROVIDER_STATUS.verified) {
      // First, update User KYC status
      await User.findByIdAndUpdate(
        provider.userId,
        { status: USER_STATUS.active, isKycVerified: true },
        { session }
      );

      updatedVerification = await Provider.findByIdAndUpdate(
        id,
        {
          status: PROVIDER_STATUS.verified,
          approvedAt: new Date(),
        },
        { returnDocument: 'after', session }
      );
    } else {
      updatedVerification = await Provider.findByIdAndUpdate(
        id,
        { status: PROVIDER_STATUS.rejected, rejectionReason },
        { returnDocument: 'after', session }
      );
    }

    // Common FCM Notification
    const user = await User.findById(provider.userId).session(session);
    if (user?.fcmToken) {
      await sendKycStatusNotification(
        updatedVerification,
        user,
        rejectionReason
      );
    }

    await session.commitTransaction();

    const emailQueue = await getEmailQueueInstance();

    // Email sending
    if (user?.email) {
      if (status === PROVIDER_STATUS.verified) {
        // Get queue instance and add job
        await emailQueue.add(
          'send-kyc-verified-email',
          {
            name: user.name,
            email: user.email
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
      } else if (status === PROVIDER_STATUS.rejected) {
        await emailQueue.add(
          'send-kyc-rejected-email',
          {
            name: user.name,
            email: user.email,
            reason: rejectionReason,
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
      }
    }

    return updatedVerification;
  } catch (error: any) {
    await session.abortTransaction();
    console.error('Provider KYC Update Error:', error);
    throw error instanceof ApiError
      ? error
      : new ApiError(
          StatusCodes.INTERNAL_SERVER_ERROR,
          error.message || 'Failed to update provider KYC status'
        );
  } finally {
    session.endSession();
  }
};

export const ProviderService = {
  insertIntoDB,
  getAllIntoDB,
  getAIntoDB,
  updateStatusIntoDB,
};
