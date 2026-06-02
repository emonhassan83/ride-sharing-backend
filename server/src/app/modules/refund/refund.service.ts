import httpStatus from 'http-status'
import QueryBuilder from '../../builder/QueryBuilder'
import { Refund } from './refund.model'
import { User } from '../user/user.model'
import { refundChangeStatusNotifyToUser } from './refund.utils'
import { REFUND_STATUS, TRefundStatus } from './refund.constant'
import { startSession } from 'mongoose'
import { TRefund } from './refund.interface'
import ApiError from '../../errors/ApiError'

const getAllRefundsFromDB = async (query: Record<string, unknown>) => {
  const refundQuery = new QueryBuilder(
    Refund.find().populate([
      {
        path: 'user',
        select: 'name email photoUrl contractNumber',
      },
      {
        path: 'order',
        select: 'title',
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
      select: 'name email photoUrl contractNumber',
    },
    {
      path: 'order',
      populate: [
        { path: 'sender', select: 'name email photoUrl contractNumber' },
        { path: 'receiver', select: 'name email photoUrl contractNumber' },
      ],
    },
  ])
  if (!refund) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Refund request not found')
  }

  return refund
}

const updateRefundStatusFromDB = async (
  id: string,
  payload: { status: TRefundStatus; note: string },
) => {
  const { status, note } = payload

  // 1. Validate status
  if (!Object.values(REFUND_STATUS).includes(status)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid refund status')
  }

  // 2. Start transaction
  const session = await startSession()
  session.startTransaction()

  try {
    // 3. Find refund request
    const refund = await Refund.findById(id).session(session)
    if (!refund) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Refund request not found!')
    }

    // // 4. Prevent invalid transitions
    // if (refund.status !== REFUND_STATUS.pending) {
    //   throw new ApiError(
    //     httpStatus.FORBIDDEN,
    //     `Refund request already ${refund.status}. Cannot change status again.`,
    //   )
    // }

    // 5. Change then update the refund status
    const result = await Refund.findByIdAndUpdate(
      id,
      { status },
      { new: true, session },
    )

    // 6. Notify user
    const user = await User.findById(refund.user).session(session)
    if (user) {
      await refundChangeStatusNotifyToUser(
        'CHANGED_STATUS',
        user,
        result as TRefund,
        note,
      )
    }

    await session.commitTransaction()
    session.endSession()

    return refund
  } catch (error: any) {
    await session.abortTransaction()
    session.endSession()
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      error.message || 'Failed to update refund status',
    )
  }
}

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
