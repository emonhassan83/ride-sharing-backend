import httpStatus from 'http-status'
import catchAsync from '../../utils/catchAsync'
import { otpServices } from './otp.service'
import sendResponse from '../../utils/sendResponse'
import { Request, Response } from 'express'

const verifyOTP = catchAsync(async (req: Request, res: Response) => {
  const token = req?.headers?.authorization
  const result = await otpServices.verifyOTP(token as string, req.body.otp, req.query)

  sendResponse(res, {
    code: httpStatus.OK,
    message: result.message,
    data: result.data,
  })
})

const sendOtpInEmail = catchAsync(async (req: Request, res: Response) => {
  const result = await otpServices.sendOtpInEmail(req.user.userId, req.body.email)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'OTP sent successfully',
    data: result,
  })
})

const sendOtpViaTokenInPhone = catchAsync(async (req: Request, res: Response) => {
  const result = await otpServices.sendOtpViaTokenInPhone(req.user.userId, req.body)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'OTP sent successfully',
    data: result,
  })
})

const sendOtpViaDirectPhone = catchAsync(async (req: Request, res: Response) => {
  const result = await otpServices.sendOtpViaDirectPhone(req.body)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'OTP sent successfully',
    data: result,
  })
})

export const otpControllers = {
  verifyOTP,
  sendOtpInEmail,
  sendOtpViaTokenInPhone,
  sendOtpViaDirectPhone
}
