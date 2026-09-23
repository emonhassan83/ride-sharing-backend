import { Router } from 'express';
import auth from '../../middlewares/auth';
import { SettingController } from './settings.controller';
import { USER_ROLE } from '../user/user.constant';
import validateRequest from '../../utils/validateRequest';
import { SettingValidation } from './settings.validation';

const router = Router();

router.get(
  '/platform-seller',
  auth(USER_ROLE.admin),
  SettingController.getPlatformSeller,
);
router.post(
  '/platform-seller',
  auth(USER_ROLE.admin),
  validateRequest(SettingValidation.updatePlatformSellerZodSchema),
  SettingController.updatePlatformSeller,
);

router.get('/generals', SettingController.getSettingGenerals);
router.post(
  '/generals',
  validateRequest(SettingValidation.updateGeneralsZodSchema),
  SettingController.updateGenerals,
);

router.get('/', SettingController.getSetting);
router.post(
  '/:key',
  auth(USER_ROLE.admin),
  validateRequest(SettingValidation.createOrUpdateSettingZodSchema),
  SettingController.createOrUpdate,
);

export const SettingsRoutes = router;
