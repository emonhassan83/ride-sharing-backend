import express from 'express';
import { UserController } from './user.controller';
import auth from '../../middlewares/auth';
import validateRequest from '../../utils/validateRequest';
import { USER_ROLE } from './user.constant';
import { UserValidation } from './user.validation';

const router = express.Router();

//main routes
router.get('/', auth(USER_ROLE.admin), UserController.getAllUsers);
router.get('/single/:id', auth(USER_ROLE.admin), UserController.getUserBasics);

// get users in radius
router.get(
  '/radius/:role/:radius',
  auth([USER_ROLE.user, USER_ROLE.provider]),
  UserController.getUsersInRadius,
);

router.put(
  '/change-email',
  auth('common'),
  validateRequest(UserValidation.changeEmailZodSchema),
  UserController.changedEmail,
);
router.put(
  '/location',
  auth([USER_ROLE.user, USER_ROLE.provider, USER_ROLE.admin]),
  validateRequest(UserValidation.updateLocationValidationSchema),
  UserController.updateMyLocation,
);

router
  .route('/:userId')
  .get(auth('common'), UserController.getSingleUser)
  .put(
    auth('common'),
    validateRequest(UserValidation.updateUserValidationSchema),
    UserController.updateUserProfile,
  )
  .patch(
    auth('admin'),
    validateRequest(UserValidation.changeStatusValidationSchema),
    UserController.updateUserStatus,
  )
  .delete(auth('common'), UserController.deleteUserProfile);

export const UserRoutes = router;
