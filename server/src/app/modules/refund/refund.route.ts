import express from 'express'
import { USER_ROLE } from '../user/user.constant'
import { RefundControllers } from './refund.controller'
import { RefundValidation } from './refund.validation'
import validateRequest from '../../utils/validateRequest'
import auth from '../../middlewares/auth'

const router = express.Router()

router.patch(
  '/status/:id',
  auth(USER_ROLE.admin),
  validateRequest(RefundValidation.updateValidationSchema),
  RefundControllers.changeRefundStatus,
)

router.delete('/:id', auth(USER_ROLE.admin), RefundControllers.deleteARefund)

router.get('/my-refund', auth(USER_ROLE.user), RefundControllers.getMyRefunds)
router.get('/', auth(USER_ROLE.admin), RefundControllers.getAllRefunds)

router.get('/:id', auth(USER_ROLE.admin), RefundControllers.getARefund)

export const RefundRoutes = router
