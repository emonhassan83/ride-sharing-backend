import express from 'express'
import { USER_ROLE } from '../user/user.constant'
import { FaqControllers } from './faq.controller'
import { FaqValidation } from './faq.validation'
import validateRequest from '../../utils/validateRequest'
import auth from '../../middlewares/auth'

const router = express.Router()

router.post(
  '/',
  auth(USER_ROLE.admin),
  validateRequest(FaqValidation.createValidationSchema),
  FaqControllers.createFaq,
)

router.put(
  '/:id',
  auth(USER_ROLE.admin),
  validateRequest(FaqValidation.updateValidationSchema),
  FaqControllers.updateFaq,
)

router.delete('/:id', auth(USER_ROLE.admin), FaqControllers.deleteAFaq)
router.get('/', FaqControllers.getAllFaqs)

export const FaqRoutes = router
