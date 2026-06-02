import { Router } from 'express';
import validateRequest from '../../utils/validateRequest';
import auth from '../../middlewares/auth';
import { ProviderController } from './provider.controller';
import { ProviderValidation } from './provider.validation';
import { USER_ROLE } from '../user/user.constant';

const router = Router();

router.post(
  '/',
  auth(USER_ROLE.provider),
  validateRequest(ProviderValidation.createProviderZodSchema),
  ProviderController.insertIntoDB,
);

router.patch(
  '/:userId',
  auth(USER_ROLE.admin),
  validateRequest(ProviderValidation.updateStatusZodSchema),
  ProviderController.updateAIntoDB,
);

router.get('/:id', auth(USER_ROLE.admin), ProviderController.getAIntoDB);
router.get('/', auth(USER_ROLE.admin), ProviderController.getAllIntoDB);

export const ProviderRoutes = router;
