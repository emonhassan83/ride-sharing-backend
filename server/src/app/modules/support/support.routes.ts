import { Router } from 'express';
import auth from '../../middlewares/auth';
import validateRequest from '../../utils/validateRequest';
import { USER_ROLE } from '../user/user.constant';
import { SupportController } from './support.controller';
import { SupportValidation } from './support.validation';

const router = Router();

router.post(
  '/',
  auth([USER_ROLE.provider, USER_ROLE.user]),
  validateRequest(SupportValidation.createSupportZodSchema),
  SupportController.create
);

router.post(
  '/sent-message/:id',
  auth(USER_ROLE.admin),
  validateRequest(SupportValidation.sentMessageValidationSchema),
  SupportController.sentSupportMessage
);

router.patch(
  '/:id',
  auth(USER_ROLE.admin),
  validateRequest(SupportValidation.changedStatusValidationSchema),
  SupportController.changeStatus
);

router.get('/', auth(USER_ROLE.admin), SupportController.getAll);
router.delete('/:id', auth(USER_ROLE.admin), SupportController.remove);

export const SupportRoutes = router;
