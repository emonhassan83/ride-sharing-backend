import express from 'express';
import { LocationHistoryController } from './locationHistory.controller';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';

const router = express.Router();

// Get location history by ride ID (for dispute)
router.get(
  '/ride/:rideId',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  LocationHistoryController.getLocationHistoryByRide
);

// Get driver's location history for analytics
router.get(
  '/driver/:driverId',
  auth(USER_ROLE.provider),
  LocationHistoryController.getDriverLocationHistory
);

export const LocationHistoryRoutes = router;
