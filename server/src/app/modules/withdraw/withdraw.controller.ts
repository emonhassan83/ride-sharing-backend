import catchAsync from '../../utils/catchAsync'
import httpStatus from 'http-status'
import sendResponse from '../../utils/sendResponse'
import { WithdrawService } from './withdraw.service'

const addWithdraw = catchAsync(async (req, res) => {
  const result = await WithdrawService.addWithdraw(req.body, req.user.userId)

  sendResponse(res, {
    code: httpStatus.CREATED,
    message: 'Withdraw insert successfully!',
    data: result,
  })
})

const getConsultWithdraw = catchAsync(async (req, res) => {
  const result = await WithdrawService.getConsultWithdrawsFromDB(req.query, req.user.userId)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Consult withdraw retrieved successfully!',
    pagination: result.meta,
    data: result.result,
  })
})

const getAllWithdraw = catchAsync(async (req, res) => {
  const result = await WithdrawService.getAllWithdrawsFromDB(req.query)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'All Withdraw retrieved successfully!',
    pagination: result.meta,
    data: result.result,
  })
})

const getAWithdraw = catchAsync(async (req, res) => {
  const result = await WithdrawService.getAWithdrawFromDB(req.params.id as string)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Withdraw retrieved successfully!',
    data: result,
  })
})

const updateWithdraw = catchAsync(async (req, res) => {
  const result = await WithdrawService.updateWithdrawFromDB(
    req.params.id as string,
    req.body
  )

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Withdraw update successfully!',
    data: result,
  })
})

export const WithdrawControllers = {
  addWithdraw,
  getAllWithdraw,
  getConsultWithdraw,
  getAWithdraw,
  updateWithdraw
}
