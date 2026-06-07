import { Router } from 'express';
import { RideController } from './ride.controller';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';

const router = Router();

// Get my own ride 
router.get(
  '/my-rides',
  auth([USER_ROLE.user, USER_ROLE.provider]),
  RideController.getMyRides
);

// Get available all ride
router.get(
  '/',
  auth(USER_ROLE.admin),
  RideController.getAllRides
);

// Get single ride details (both user & driver can access)
router.get(
  '/:id',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  RideController.getARides
);

export const RideRoutes = router;