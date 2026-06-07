import { Router } from 'express';
import { RideController } from './ride.controller';
import auth from '../../middlewares/auth';
import { RideValidation } from './ride.validation';
import validateRequest from '../../utils/validateRequest';
import { USER_ROLE } from '../user/user.constant';

const router = Router();

// ====================== USER (Passenger) ROUTES ======================

// Create new ride request to a specific driver
router.post(
  '/',
  auth(USER_ROLE.user),
  validateRequest(RideValidation.createRideZodSchema),
  RideController.createRideRequest
);

// Get my own ride requests (as passenger)
router.get(
  '/my-rides',
  auth(USER_ROLE.user),
  RideController.getMyRides
);

// Nearby drivers (as passenger)
router.get(
  '/nearby-drivers',
  auth(USER_ROLE.user),
  RideController.findNearbyAvailableDrivers
);

// ====================== DRIVER (Provider) ROUTES ======================

// Get available ride requests for driver
router.get(
  '/available-requests',
  auth(USER_ROLE.provider),
  RideController.getAvailableRequestsForDriver
);

// ====================== COMMON ROUTES ======================

// Get single ride details (both user & driver can access)
router.get(
  '/:id',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  RideController.getARides
);

export const RideRoutes = router;