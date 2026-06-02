import { Router } from 'express';
import auth from '../../middlewares/auth';
import validateRequest from '../../utils/validateRequest';
import { SavedPlacesValidation } from './savedPlaces.validation';
import { SavedPlacesController } from './savedPlaces.controller';
import { USER_ROLE } from '../user/user.constant';

const router = Router();

router.post(
  '/',
  auth(USER_ROLE.user),
  validateRequest(SavedPlacesValidation.createSavedPlacesZodSchema),
  SavedPlacesController.createUserLocation
);

router.get('/', auth(USER_ROLE.user), SavedPlacesController.getMyLocations);

router.patch(
  '/pinned/:id',
  auth(USER_ROLE.user),
  SavedPlacesController.togglePinSavedLocation
);
router.put(
  '/:id',
  auth(USER_ROLE.user),
  validateRequest(SavedPlacesValidation.updateSavedPlacesZodSchema),
  SavedPlacesController.updateUserLocation
);

router.delete(
  '/:id',
  auth(USER_ROLE.user),
  SavedPlacesController.deleteUserLocation
);

export const UserLocationRoutes = router;
