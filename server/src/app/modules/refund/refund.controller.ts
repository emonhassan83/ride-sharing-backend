import catchAsync from '../../utils/catchAsync'
import sendResponse from '../../utils/sendResponse'
import { RefundServices } from './refund.service'
import httpStatus from 'http-status'

const getAllRefunds = catchAsync(async (req, res) => {
  const result = await RefundServices.getAllRefundsFromDB(req.query)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Sender refund requests retrieved successfully!',
    pagination: result.meta,
    data: result.result,
  })
})

const getARefund = catchAsync(async (req, res) => {
  const result = await RefundServices.getARefundFromDB(req.params.id as string)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Refund request retrieved successfully!',
    data: result,
  })
})

const changeRefundStatus = catchAsync(async (req, res) => {
  const result = await RefundServices.updateRefundStatusFromDB(
    req.params.id as string,
    req.body,
  )

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Refund request status updated successfully!',
    data: result,
  })
})

const deleteARefund = catchAsync(async (req, res) => {
  const result = await RefundServices.deleteARefundFromDB(req.params.id as string)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Refund request deleted successfully!',
    data: result,
  })
})

export const RefundControllers = {
  getAllRefunds,
  getARefund,
  changeRefundStatus,
  deleteARefund,
}
