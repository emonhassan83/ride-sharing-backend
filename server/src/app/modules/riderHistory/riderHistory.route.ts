import express from 'express';
import { RiderHistoryController } from './riderHistory.controller';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';

const router = express.Router();

// Get trip history with filters
router.get(
  '/history',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  RiderHistoryController.getTripHistory
);

// Get rider statistics
router.get(
  '/history/stats/summary',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  RiderHistoryController.getRiderStats
);

// Get monthly spending trend
router.get(
  '/history/trend/monthly',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  RiderHistoryController.getMonthlyTrend
);

// Get single ride details
router.get(
  '/history/:rideId',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  RiderHistoryController.getRideDetails
);

// Get ride route points for map
router.get(
  '/history/:rideId/route',
  auth([USER_ROLE.admin, USER_ROLE.provider, USER_ROLE.user]),
  RiderHistoryController.getRideRoute
);

export const RiderHistoryRoutes = router;
