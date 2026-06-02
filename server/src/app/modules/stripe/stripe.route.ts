import { Router } from 'express'
import { stripeController } from './stripe.controller'
import { USER_ROLE } from '../user/user.constant'
import { StripeValidation } from './stripe.validation'
import auth from '../../middlewares/auth'
import validateRequest from '../../utils/validateRequest'

const router = Router()

router.post(
  '/connect-existing',
  auth(USER_ROLE.provider),
  validateRequest(StripeValidation.connectValidationSchema),
  stripeController.connectExistingStripeAccount,
)
router.post(
  '/connect',
  auth(USER_ROLE.provider),
  stripeController.stripLinkAccount,
)

// Disconnect Stripe
router.delete(
  '/disconnect',
  auth(USER_ROLE.provider),
  stripeController.disconnectStripe,
)

// Get account status
router.get(
  '/account-status',
  auth(USER_ROLE.provider),
  stripeController.getStripeAccountStatus,
)

router.get(
  '/check-connection',
  auth(USER_ROLE.provider),
  stripeController.checkStripeConnected,
)

router.get('/oauth/callback', stripeController?.handleStripeOAuth)
router.get('/return', stripeController.returnUrl)
router.get('/refresh/:id', stripeController.refresh)

export const StripeRoute = router
