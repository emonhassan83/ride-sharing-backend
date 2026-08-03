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

router.post(
  '/confirm-payment',
  validateRequest(PaymentValidation.confirmPaymentSchema),
  PaymentControllers.confirmPayment
);

router.get('/', auth(USER_ROLE.admin), PaymentControllers.getAllPayments);

router.get(
  '/dashboard-data',
  auth(USER_ROLE.admin),
  PaymentControllers.getDashboardData
);

router.get('/booking/:bookingId', PaymentControllers.getAPaymentByBookingId);

router.get(
  '/:id',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  PaymentControllers.getAPayment
);

router.patch('/refund-payment', PaymentControllers.refundPayment);

export const PaymentRoutes = router;


