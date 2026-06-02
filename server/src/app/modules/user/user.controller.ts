import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { UserService } from './user.service';
import { TUserRole } from './user.constant';
import { config } from '../../config/env.config';

const getAllUsers = catchAsync(async (req, res) => {
  const result = await UserService.getAllUsersFromDB(req.query);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Users retrieved successfully',
    data: result.result,
    pagination: result.meta,
  });
});

const getSingleUser = catchAsync(async (req, res) => {
  const result = await UserService.getSingleUser(req.params.userId as string);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'User retrieve successfully!',
    data: result,
  });
});

const getUserBasics = catchAsync(async (req, res) => {
  const result = await UserService.getUserBasics(req.params.id as string);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'User retrieved successfully!',
    data: result,
  });
});

const getUsersInRadius = catchAsync(async (req, res) => {
  const { radius, role } = req.params;

  const result = await UserService.getUsersInRadius(
    req.user.userId,
    Number(radius),
    role as TUserRole
  );

  sendResponse(res, {
    code: StatusCodes.OK,
    data: result,
    message: 'Users in radius fetched successfully',
  });
});

const changedEmail = catchAsync(async (req, res) => {
  const result = await UserService.changeEmail(
    req.user.userId as string,
    req.body
  );
  const { refreshToken, accessToken, user } = result;

  res.cookie('refreshToken', refreshToken, {
    secure: config.environment === 'production',
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60 * 24 * 365,
  });

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'User email changed successfully! Please login again',
    data: {
      accessToken,
      refreshToken,
      user,
    },
  });
});

const updateUserProfile = catchAsync(async (req, res) => {
  req.body.status = undefined;
  req.body.email = undefined;
  req.body.role = undefined;
  const result = await UserService.updateUserProfile(
    req.params.userId as string,
    req.body
  );

  sendResponse(res, {
    code: StatusCodes.OK,
    data: result,
    message: 'User updated successfully',
  });
});

const updateMyLocation = catchAsync(async (req, res) => {
  const result = await UserService.updateLocationFromDB(
    req?.user?.userId,
    req.body
  );

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Location update successfully!',
    data: result,
  });
});

const updateUserStatus = catchAsync(async (req, res) => {
  const result = await UserService.updateUserStatus(
    req.params.userId as string,
    req.body
  );

  sendResponse(res, {
    code: StatusCodes.OK,
    data: result,
    message: 'User status or role updated successfully',
  });
});

const deleteUserProfile = catchAsync(async (req, res) => {
  const result = await UserService.deleteUserProfile(req.user.userId, req.body);

  sendResponse(res, {
    code: StatusCodes.OK,
    data: result,
    message: 'User deleted successfully',
  });
});

export const UserController = {
  getAllUsers,
  getSingleUser,
  getUserBasics,
  changedEmail,
  updateUserStatus,
  updateMyLocation,
  getUsersInRadius,
  updateUserProfile,
  deleteUserProfile,
};
