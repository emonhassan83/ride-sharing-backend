import { Router } from 'express';
import auth from '../../middlewares/auth';
import { USER_ROLE } from '../user/user.constant';
import { VehicleController } from './vehicle.controller';
import validateRequest from '../../utils/validateRequest';
import { VehicleValidation } from './vehicle.validation';

const router = Router();

router.post(
  '/multiple',
  auth(USER_ROLE.provider),
  validateRequest(VehicleValidation.createMultipleVehiclesZodSchema),
  VehicleController.addMultipleCar,
);
router.post(
  '/',
  auth(USER_ROLE.provider),
  validateRequest(VehicleValidation.createVehicleZodSchema),
  VehicleController.addACar,
);
router.patch('/:id', auth(USER_ROLE.provider), VehicleController.setAsDefault);
router.put(
  '/:id',
  auth(USER_ROLE.provider),
  validateRequest(VehicleValidation.createVehicleZodSchema),
  VehicleController.updateACar,
);

router.delete('/:id', auth(USER_ROLE.provider), VehicleController.deleteACar);
router.get('/', auth(USER_ROLE.provider), VehicleController.getMyCars);

export const VehicleRoutes = router;
