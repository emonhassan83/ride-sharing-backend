import { Router } from 'express';
import auth from '../../middlewares/auth';
import { ReviewsController } from './review.controller';
import { USER_ROLE } from '../user/user.constant';
import validateRequest from '../../utils/validateRequest';
import { ReviewsValidation } from './review.validation';

const router = Router();

router.get(
  '/:userId',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  ReviewsController.getReviewsByUser,
);
router.post(
  '/',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  validateRequest(ReviewsValidation.createValidationSchema),
  ReviewsController.createReviews,
);

export const ReviewRoutes = router;
