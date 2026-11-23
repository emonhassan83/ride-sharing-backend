import express from 'express';
import { USER_ROLE } from '../user/user.constant';
import { PaymentValidation } from './payment.validation';
import { PaymentControllers } from './payment.controllers';
import validateRequest from '../../utils/validateRequest';
import auth from '../../middlewares/auth';

const router = express.Router();

router.post(
  '/checkout',
  auth(USER_ROLE.user),
  validateRequest(PaymentValidation.createValidationSchema),
  PaymentControllers.checkout
);

router.post(
  '/pay-with-wallet',
  auth(USER_ROLE.user),
  PaymentControllers.payWithWallet
);

// Security (round 3): confirm, refund and payment reads used to have no auth at all.
router.post(
  '/confirm-payment',
  auth([USER_ROLE.user, USER_ROLE.admin]),
  validateRequest(PaymentValidation.confirmPaymentSchema),
  PaymentControllers.confirmPayment
);

router.get('/', auth(USER_ROLE.admin), PaymentControllers.getAllPayments);

router.get(
  '/dashboard-data',
  auth(USER_ROLE.admin),
  PaymentControllers.getDashboardData
);

router.get(
  '/booking/:bookingId',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  PaymentControllers.getAPaymentByBookingId,
);

router.get(
  '/:id',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  PaymentControllers.getAPayment
);

router.patch(
  '/refund-payment',
  auth(USER_ROLE.admin),
  validateRequest(PaymentValidation.refundPaymentSchema),
  PaymentControllers.refundPayment,
);

export const PaymentRoutes = router;


