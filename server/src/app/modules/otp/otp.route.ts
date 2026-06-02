import { Router } from 'express'
import { otpControllers } from './otp.controller'
import { resentOtpValidations } from './otp.validation'
import { USER_ROLE } from '../user/user.constant'
import auth from '../../middlewares/auth'
import validateRequest from '../../utils/validateRequest'
const router = Router()

router.post(
  '/verify',
  validateRequest(resentOtpValidations.verifyOtpZodSchema),
  otpControllers.verifyOTP,
)

router.post(
  '/send-otp-in-email',
  auth('common'),
  validateRequest(resentOtpValidations.resentOtpInEmail),
  otpControllers.sendOtpInEmail,
)

router.post(
  '/send-otp-via-token-in-phone',
  auth('common'),
  otpControllers.sendOtpViaTokenInPhone,
)

router.post(
  '/send-otp-via-direct-phone',
  validateRequest(resentOtpValidations.resentOtpInPhone),
  otpControllers.sendOtpViaDirectPhone,
)

export const otpRoutes = router
