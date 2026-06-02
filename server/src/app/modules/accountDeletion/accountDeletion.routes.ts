import { Router } from 'express';
import { AccountDeletionController } from './accountDeletion.controller';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';

const router = Router();

router.get(
  '/',
  auth(USER_ROLE.admin),
  AccountDeletionController.getAllDeletions
);

router.get(
  '/:id',
  auth(USER_ROLE.admin),
  AccountDeletionController.getSingleDeletion
);

router.delete(
  '/:id',
  auth(USER_ROLE.admin),
  AccountDeletionController.deleteDeletionRecord
);

export const AccountDeletionRoutes = router;
