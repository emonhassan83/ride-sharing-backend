import httpStatus from 'http-status'
import QueryBuilder from '../../builder/QueryBuilder'
import { Refund } from './refund.model'
import { User } from '../user/user.model'
import { refundChangeStatusNotifyToUser } from './refund.utils'
import { REFUND_STATUS, TRefundStatus } from './refund.constant'
import mongoose from 'mongoose'
import { TRefund } from './refund.interface'
import ApiError from '../../errors/ApiError'
import { PaymentService } from '../payment/payment.service'

const getAllRefundsFromDB = async (query: Record<string, unknown>) => {
  const refundQuery = new QueryBuilder(
    Refund.find().populate([
      {
        path: 'user',
        select: 'name profileImage',
      },
      {
        path: 'order',
        select: 'id passengerId',
         populate: {
          path: 'passengerId',
          select: 'pickup destination requestedSeats',
        },
      },
    ]),
    query,
  )
    .search([''])
    .filter()
    .sort()
    .paginate()
    .fields()

  const refunds = await refundQuery.modelQuery
  const meta = await refundQuery.countTotal()

  return {
    meta,
    result: refunds,
  }
}

const getARefundFromDB = async (id: string) => {
  // Step 1: Get the refund with related data
  const refund = await Refund.findById(id).populate([
    {
      path: 'user',
      select: 'name email profileImage phone',
    },
    {
        path: 'order',
        select: 'id passengerId',
         populate: {
          path: 'passengerId',
          select: 'pickup destination requestedSeats',
        },
      },
  ])
  if (!refund) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Refund request not found')
  }

  return refund
}

const updateRefundStatusFromDB = async (
  id: string,
  payload: { status: TRefundStatus; note?: string }
) => {
  const { status, note } = payload;

  if (!Object.values(REFUND_STATUS).includes(status)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid refund status');
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const refund = await Refund.findById(id).session(session);
    if (!refund) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Refund request not found!');
    }

    if (refund.status !== REFUND_STATUS.pending) {
      throw new ApiError(
        httpStatus.FORBIDDEN,
        `Refund request is already ${refund.status}. Cannot change again.`
      );
    }

    let updatedRefund: TRefund | null = null;

    if (status === REFUND_STATUS.confirmed) {
      // === ALWAYS REFUND TO WALLET (No Stripe Refund) ===
      
      // Add money back to user's wallet
      const user = await User.findByIdAndUpdate(
        refund.user,
        { $inc: { wallet: refund.amount } },
        { session, new: true }
      );

      if (!user) {
        throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
      }

      updatedRefund = await Refund.findByIdAndUpdate(
        id,
        {
          status: REFUND_STATUS.confirmed,
          note: note || `Refunded ${refund.amount} to wallet`,
          processedAt: new Date(),
        },
        { new: true, session }
      );

      console.log(`💰 Refunded ${refund.amount} to wallet | User: ${refund.user}`);
    } 
    else if (status === REFUND_STATUS.rejected) {
      updatedRefund = await Refund.findByIdAndUpdate(
        id,
        {
          status: REFUND_STATUS.rejected,
          note: note || 'Refund request rejected by admin',
        },
        { new: true, session }
      );
    }

    if (!updatedRefund) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to update refund record');
    }

    // Notify User
    const notifiedUser = await User.findById(refund.user).session(session);
    if (notifiedUser) {
      await refundChangeStatusNotifyToUser(
        'CHANGED_STATUS',
        notifiedUser,
        updatedRefund,
        note || ''
      );
    }

    await session.commitTransaction();
    session.endSession();

    return updatedRefund;
  } catch (error: any) {
    await session.abortTransaction();
    session.endSession();
    console.error('Refund Status Update Error:', error);
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      error.message || 'Failed to update refund status'
    );
  }
};

const deleteARefundFromDB = async (id: string) => {
  const refund = await Refund.findById(id)
  if (!refund) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      'This Refund request is not found !',
    )
  }
  if (refund.status !== REFUND_STATUS.pending) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Only pending refund eligible for deleted!',
    )
  }

  const result = await Refund.findByIdAndDelete(id)
  if (!result) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Refund request Delete failed!')
  }

  return result
}

export const RefundServices = {
  getAllRefundsFromDB,
  getARefundFromDB,
  updateRefundStatusFromDB,
  deleteARefundFromDB,
}
