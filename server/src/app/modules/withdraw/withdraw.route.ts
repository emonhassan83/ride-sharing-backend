import express from 'express'
import { USER_ROLE } from '../user/user.constant'
import { WithdrawControllers } from './withdraw.controller'
import { WithdrawValidation } from './withdraw.validation'
import validateRequest from '../../utils/validateRequest'
import auth from '../../middlewares/auth'

const router = express.Router()

router.post(
  '/',
  auth(USER_ROLE.provider),
  validateRequest(WithdrawValidation.createValidationSchema),
  WithdrawControllers.addWithdraw,
)

router.patch(
  '/:id',
  auth(USER_ROLE.admin),
  validateRequest(WithdrawValidation.updateValidationSchema),
  WithdrawControllers.updateWithdraw,
)

router.get(
  '/my-withdraws',
  auth(USER_ROLE.provider),
  WithdrawControllers.getConsultWithdraw,
)

router.get('/', auth(USER_ROLE.admin), WithdrawControllers.getAllWithdraw)

router.get('/:id', auth(USER_ROLE.admin), WithdrawControllers.getAWithdraw)

export const WithdrawRoutes = router
