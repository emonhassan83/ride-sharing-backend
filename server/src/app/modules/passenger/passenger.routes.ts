import { Router } from 'express';
import { PassengerController } from './passenger.controller';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';

const router = Router();

// Create passenger (testing purpose)
router.post(
  '/',
  auth(USER_ROLE.user),
  PassengerController.createPassenger
);

// Get all passengers by rideId
router.get(
  '/ride/:rideId/passengers',
  auth([USER_ROLE.user, USER_ROLE.provider]),
  PassengerController.getPassengersByRide
);

// Get single passenger by passengerId
router.get(
  '/passenger/:id',
  auth([USER_ROLE.user, USER_ROLE.provider]),
  PassengerController.getAPassenger
);

export const PassengerRoutes = router;
