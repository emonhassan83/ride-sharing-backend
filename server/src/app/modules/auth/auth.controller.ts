import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { AuthService } from './auth.service';
import { config } from '../../config/env.config';
import { otpServices } from '../otp/otp.service';

const register = catchAsync(async (req, res) => {
  const result = await AuthService.createUser(req.body);
  const sendOtp = await otpServices.sendOtpViaTokenInPhone(
    result._id.toString(),
    {
      phoneNumber: result.phone as string,
    },
  );

  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'User created successfully, please verify your email',
    data: sendOtp,
  });
});

const registerWithGoogle = catchAsync(async (req, res) => {
  const result = await AuthService.registerWithGoogle(req.body);
  const { refreshToken } = result;

  const cookieOptions: any = {
    secure: false,
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 365,
  };

  if (config.environment === 'production') {
    cookieOptions.sameSite = 'none';
  }
  res.cookie('refreshToken', refreshToken, cookieOptions);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Logged in successfully',
    data: result,
  });
});

const registerWithApple = catchAsync(async (req, res) => {
  const result = await AuthService.registerWithApple(req.body);
  const { refreshToken } = result;

  const cookieOptions: any = {
    secure: false,
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 365,
  };

  if (config.environment === 'production') {
    cookieOptions.sameSite = 'none';
  }
  res.cookie('refreshToken', refreshToken, cookieOptions);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Logged in successfully',
    data: result,
  });
});

const loginWithEmail = catchAsync(async (req, res) => {
  const result = await AuthService.loginWithEmail(req.body);
  const { refreshToken, accessToken, user } = result;

  res.cookie('refreshToken', refreshToken, {
    secure: config.environment === 'production',
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60 * 24 * 365,
  });

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'User login successfully!',
    data: {
      accessToken,
      refreshToken,
      user,
    },
  });
});

const loginWithPhone = catchAsync(async (req, res) => {
  const result = await AuthService.loginWithPhone(req.body);

  res.cookie('refreshToken', refreshToken, {
    secure: config.environment === 'production',
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60 * 24 * 365,
  });

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Otp sent successfully please checked your phone!',
    data: result,
  });
});

const forgotPassword = catchAsync(async (req, res) => {
  const result = await AuthService.forgotPassword(req.body);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Password reset email sent successfully',
    data: result,
  });
});

const resetPassword = catchAsync(async (req, res) => {
  const result = await AuthService.resetPassword(req.user.userId, req.body);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Password reset successfully',
    data: result,
  });
});

const changePassword = catchAsync(async (req, res) => {
  const result = await AuthService.changePassword(req.user.userId, req.body);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Password is updated successfully!',
    data: result,
  });
});

const logout = catchAsync(async (req, res) => {
  await AuthService.logoutUser(req.user.userId);

  // Clear refreshToken cookie
  res.clearCookie('refreshToken', {
    secure: config.environment === 'production',
    httpOnly: true,
    sameSite: 'none',
  });

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'User logout successfully!',
    data: null,
  });
});

const refreshToken = catchAsync(async (req, res) => {
  const { refreshToken } = req.cookies;
  const result = await AuthService.refreshToken(refreshToken);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Access token is retrieved successfully!',
    data: result,
  });
});

export const AuthController = {
  register,
  registerWithGoogle,
  registerWithApple,
  loginWithEmail,
  loginWithPhone,
  logout,
  changePassword,
  refreshToken,
  forgotPassword,
  resetPassword,
};
