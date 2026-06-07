import { Router } from 'express';
import { PassengerController } from './passenger.controller';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';

const router = Router();

// Get ride requests for a driver (pending passenger requests for the driver's rides)
router.get(
  '/ride-requests',
  auth(USER_ROLE.provider),
  PassengerController.getDriverRideRequest
);

// Get all passengers by rideId
router.get(
  '/ride/:rideId',
  auth([USER_ROLE.user, USER_ROLE.provider]),
  PassengerController.getPassengersByRide
);

// Get single passenger by passengerId
router.get(
  '/:id',
  auth([USER_ROLE.user, USER_ROLE.provider]),
  PassengerController.getAPassenger
);

export const PassengerRoutes = router;
