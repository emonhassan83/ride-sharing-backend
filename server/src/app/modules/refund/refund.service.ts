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

const REFUND_ALREADY_PROCESSED = 'This refund request has already been processed.'

const getAllRefundsFromDB = async (query: Record<string, unknown>) => {
  const refundQuery = new QueryBuilder(
    Refund.find().populate([
      {
        path: 'user',
        select: 'name profileImage',
      },
      {
        path: 'ride',
        select: 'id pickup destination'
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
  let committedRefund!: TRefund;

  try {
    const refund = await Refund.findById(id).session(session);
    if (!refund) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Refund request not found!');
    }

    if (refund.status !== REFUND_STATUS.pending) {
      // Fixed (translatable) text; the current status is visible on the refund itself.
      throw new ApiError(httpStatus.CONFLICT, REFUND_ALREADY_PROCESSED);
    }

    let updatedRefund: TRefund | null = null;

    if (status === REFUND_STATUS.confirmed) {
      // === ALWAYS REFUND TO WALLET (No Stripe Refund) ===

      // Add money back to user's wallet
      const user = await User.findByIdAndUpdate(
        refund.user,
        { $inc: { wallet: refund.amount } },
        { session, returnDocument: 'after' }
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
        { returnDocument: 'after', session }
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
        { returnDocument: 'after', session }
      );
    }

    if (!updatedRefund) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to update refund record');
    }

    await session.commitTransaction();
    session.endSession();
    committedRefund = updatedRefund;
  } catch (error: any) {
    if (session.inTransaction()) await session.abortTransaction();
    session.endSession();

    // Expected errors (404 not found, 409 already processed, 400 invalid status)
    // keep their status and message; they used to be turned into a 500.
    if (error instanceof ApiError) throw error;

    // Two admins approving the same refund at once: the losing transaction gets
    // a write conflict. It is the same situation as "already processed".
    if (
      error?.code === 112 ||
      error?.codeName === 'WriteConflict' ||
      error?.errorLabels?.includes?.('TransientTransactionError')
    ) {
      throw new ApiError(httpStatus.CONFLICT, REFUND_ALREADY_PROCESSED);
    }

    // Anything else is internal: log it, never send its raw message to the client.
    console.error('Refund Status Update Error:', error);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to update refund status');
  }

  // Notify only AFTER the commit. The push used to be sent inside the transaction:
  // a failing notification rolled back the wallet credit, and a rider could be told
  // about a refund that was never saved. A push failure must not undo the refund.
  try {
    const notifiedUser = await User.findById(committedRefund.user);
    if (notifiedUser) {
      await refundChangeStatusNotifyToUser('CHANGED_STATUS', notifiedUser, committedRefund, note || '');
    }
  } catch (error: any) {
    console.error('Refund status notification failed:', error?.message || error);
  }

  return committedRefund;
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
