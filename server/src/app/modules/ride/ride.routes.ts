import { Router } from 'express';
import { RideController } from './ride.controller';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import validateRequest from '../../utils/validateRequest';
import { RideValidation } from './ride.validation';

const router = Router();

// Get my own ride
router.get(
  '/driver-rides',
  auth(USER_ROLE.provider),
  RideController.getDriverRides
);
router.get('/rider-rides', auth(USER_ROLE.user), RideController.getRiderRides);

// Monthly driver invoice (must be before /:id)
router.get(
  '/driver-invoice',
  auth([USER_ROLE.provider, USER_ROLE.admin]),
  validateRequest(RideValidation.driverInvoiceQueryZodSchema),
  RideController.getDriverInvoice
);

// Ride Start OTP authorization (send OTP to passenger & verify before starting ride)
router.post(
  '/send-start-otp',
  auth([USER_ROLE.provider, USER_ROLE.user, USER_ROLE.admin]),
  RideController.sendStartOtp
);

router.post(
  '/verify-start-otp',
  auth([USER_ROLE.provider, USER_ROLE.user, USER_ROLE.admin]),
  RideController.verifyStartOtp
);

// Get available all ride
router.get('/', auth(USER_ROLE.admin), RideController.getAllRides);

// Get single ride details (both user & driver can access)
router.get(
  '/:id',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  RideController.getARide
);

router.delete('/:id', auth(USER_ROLE.admin), RideController.deleteARide);

export const RideRoutes = router;
