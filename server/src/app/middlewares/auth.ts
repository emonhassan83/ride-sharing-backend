import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import jwt, { JwtPayload, Secret } from 'jsonwebtoken';
import { User } from '../modules/user/user.model';
import ApiError from '../errors/ApiError';
import catchAsync from '../utils/catchAsync';
import { config } from '../config/env.config';
import { TUserRole, USER_ROLE } from '../modules/user/user.constant';

const auth = (role: string | TUserRole[]) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    // Allow OPTIONS requests to pass through without authentication
    if (req.method === 'OPTIONS') {
      next();
      return;
    }

    // base case
    if (!role) throw new ApiError(StatusCodes.FORBIDDEN, 'Role is not defined');

    // Step 1: Get Authorization Header
    const tokenWithBearer = req.headers.authorization;
    if (!tokenWithBearer) {
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'You are not authorized');
    }
    if (!tokenWithBearer.startsWith('Bearer')) {
      // If the token format is incorrect
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'You are not authorized');
    }

    const token = tokenWithBearer.split(' ')[1];
    // Step 2: Verify Token
    let verifyUser;
    try {
      verifyUser = jwt.verify(
        token,
        config.jwt.accessSecret as string
      ) as JwtPayload;
    } catch (error) {
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'Unauthorized Access!');
    }

    // Step 3: Attach user to the request object
    req.user = verifyUser;

    // Step 4: Check if the user exists and is active
    const user = await User.findById(verifyUser.userId);
    if (!user || user.isDeleted) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'User not found.');
    }

    // Step 5: Role-based Authorization
    if (role === 'common') role = Object.values(USER_ROLE) as TUserRole[];
    else if (typeof role === 'string') role = [role as TUserRole];

    if (!role.includes(user.role as TUserRole)) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "You don't have permission to access this API"
      );
    }

    // Step 6: update params.userId
    const { userId } = req.params;
    if (userId) {
      if (userId === 'me' || userId === user._id?.toString()) {
        req.params.userId = verifyUser.userId;
        req.body.status = undefined; // remove status from body if it exists
        req.body.role = undefined; // remove role from body if it exists
      } else if (user.role !== 'admin') {
        // if the user is not an admin and passing other userId
        throw new ApiError(
          StatusCodes.FORBIDDEN,
          "You don't have permission to access this API"
        );
      }
    }

    next();
  });

export default auth;
