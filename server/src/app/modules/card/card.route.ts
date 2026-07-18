import { Router } from 'express';
import { CardController } from './card.controller';
import { USER_ROLE } from '../user/user.constant';
import auth from '../../middlewares/auth';
import validateRequest from '../../utils/validateRequest';
import { CardValidation } from './card.validation';

const router = Router();

router.post(
  '/',
  auth(USER_ROLE.user),
  validateRequest(CardValidation.setupInitiateSchema),
  CardController.setupInitiate
);

router.get(
  '/list',
  auth(USER_ROLE.user),
  CardController.getCardList
);

router.delete(
  '/:cardId',
  auth(USER_ROLE.user),
  CardController.deleteCard
);

router.post(
  '/set-default',
  auth(USER_ROLE.user),
  validateRequest(CardValidation.setDefaultCardSchema),
  CardController.setDefaultCard
);

export const CardRoutes = router;
