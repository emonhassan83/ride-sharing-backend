import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { User } from '../modules/user/user.model';
import ApiError from '../errors/ApiError';
import catchAsync from '../utils/catchAsync';
import { config } from '../config/env.config';
import { TUserRole, USER_ROLE } from '../modules/user/user.constant';

const auth = (allowedRoles: string | TUserRole[] = 'common') =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    // Allow preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
      return next();
    }

    // Get token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'You are not authorized');
    }

    const token = authHeader.split(' ')[1];

    // Verify token
    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(token, config.jwt.accessSecret as string) as JwtPayload;
    } catch (error) {
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'Invalid or expired token');
    }

    if (!decoded?.userId) {
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'Invalid token payload');
    }

    // Fetch user from DB
    const user = await User.findById(decoded.userId)
      .select('role status isDeleted')
      .lean();

    if (!user) {
      throw new ApiError(StatusCodes.UNAUTHORIZED, 'User not found');
    }

    if (user.isDeleted) {
      throw new ApiError(StatusCodes.FORBIDDEN, 'Your account has been deleted');
    }

    // Attach user to request
    req.user = {
      userId: user._id.toString(),
      role: user.role,
      status: user.status || 'active',
    };

    // Role Authorization
    let rolesToCheck: TUserRole[] = [];

    if (allowedRoles === 'common') {
      rolesToCheck = Object.values(USER_ROLE) as TUserRole[];
    } else if (typeof allowedRoles === 'string') {
      rolesToCheck = [allowedRoles as TUserRole];
    } else {
      rolesToCheck = allowedRoles;
    }

    if (!rolesToCheck.includes(user.role as TUserRole)) {
      throw new ApiError(
        StatusCodes.FORBIDDEN,
        "You don't have permission to access this resource"
      );
    }

    // Handle special 'me' param
    if (req.params.userId) {
      if (req.params.userId === 'me' || req.params.userId === user._id.toString()) {
        req.params.userId = user._id.toString();

        // Safely clear sensitive fields from body (if body exists)
        if (req.body) {
          delete req.body.status;
          delete req.body.role;
          delete req.body.isDeleted;
        }
      } 
      // else if (user.role !== USER_ROLE.admin) {
      //   throw new ApiError(
      //     StatusCodes.FORBIDDEN,
      //     "You don't have permission to access other user's data"
      //   );
      // }
    }

    next();
  });

export default auth;