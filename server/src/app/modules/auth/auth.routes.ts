import { Router } from 'express';
import { AuthController } from './auth.controller';
import validateRequest from '../../utils/validateRequest';
import { AuthValidation } from './auth.validations';
import auth from '../../middlewares/auth';
import { UserValidation } from '../user/user.validation';

const router = Router();

router.post(
  '/register',
  validateRequest(UserValidation.createUserValidationSchema),
  AuthController.register
);

router.post(
  '/apple',
  validateRequest(AuthValidation.appleZodValidationSchema),
  AuthController.registerWithApple
);

router.post(
  '/google',
  validateRequest(AuthValidation.googleZodValidationSchema),
  AuthController.registerWithGoogle
);

router.post(
  '/login-with-email',
  validateRequest(AuthValidation.loginValidationSchema),
  AuthController.loginWithEmail
);

router.post(
  '/login-with-phone',
  validateRequest(AuthValidation.loginWithPhoneValidationSchema),
  AuthController.loginWithPhone
);

router.post(
  '/forgot-password',
  validateRequest(AuthValidation.forgotPasswordValidationSchema),
  AuthController.forgotPassword
);

router.post(
  '/reset-password',
  auth('common'),
  validateRequest(AuthValidation.resetPasswordValidationSchema),
  AuthController.resetPassword
);

router.post(
  '/change-password',
  auth('common'),
  validateRequest(AuthValidation.changePasswordValidationSchema),
  AuthController.changePassword
);

router.post('/logout', auth('common'), AuthController.logout);
router.post('/refresh-auth', AuthController.refreshToken);

export const AuthRoutes = router;
