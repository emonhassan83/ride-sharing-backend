import { Router } from 'express';
import { BookingController } from './booking.controller';
import auth from '../../middlewares/auth';
import { BookingValidation } from './booking.validation';
import validateRequest from '../../utils/validateRequest';
import { USER_ROLE } from '../user/user.constant';

const router = Router();

// ====================== ADMIN ROUTES ======================
router.get(
  '/',
  auth(USER_ROLE.admin),
  BookingController.getAllBookings
);

// ====================== USER & DRIVER ROUTES ======================
router.get(
  '/my-bookings',
  auth([USER_ROLE.user, USER_ROLE.provider]),
  BookingController.getMyBookings
);

router.get(
  '/:id',
  auth([USER_ROLE.user, USER_ROLE.admin, USER_ROLE.provider]),
  BookingController.getBooking
);

// Status Update
router.patch(
  '/status/:id',
  auth([USER_ROLE.admin, USER_ROLE.provider]),                    
  validateRequest(BookingValidation.updateBookingStatusZodSchema),
  BookingController.updateBookingStatus
);

export const BookingRoutes = router;
