import jwt from 'jsonwebtoken';
import httpStatus from 'http-status';
import { Socket } from 'socket.io';
import { config } from '../../config/env.config';
import ApiError from '../../errors/ApiError';
import { User } from '../../modules/user/user.model';
import { Vehicle } from '../../modules/vehicle/vehicle.model';
import { USER_ROLE } from '../../modules/user/user.constant';

// NOTE: Socket.IO middleware `use` does NOT support async directly.
// But we can use a wrapper that calls next() after async operations.
export const socketAuth = async (socket: Socket, next: (err?: Error) => void) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.token;
    if (!token) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'you are not authorized!'));
    }
    
    // 1. Verify JWT
    let decoded: any;
    try {
      decoded = jwt.verify(token, config.jwt.accessSecret as string);
    } catch (err) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Invalid token!'));
    }
    

    if (!decoded || !decoded.userId) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Invalid token payload'));
    }

    // 2. Fetch user from DB (without password)
    const user = await User.findById(decoded.userId)
      .select('_id email role name phone profileImage location avgRating')
      .lean();

    if (!user) {
      return next(new ApiError(httpStatus.NOT_FOUND, 'User not found'));
    }

    // 3. If driver, fetch default vehicle
    let vehicleInfo = null;
    if (user.role === USER_ROLE.provider) {
      const vehicle = await Vehicle.findOne({ userId: user._id, isDefault: true })
        .select('name number year seats color')
        .lean();
      if (vehicle) {
        vehicleInfo = {
          model: vehicle.name,
          number: vehicle.number,
          year: vehicle.year,
          seats: vehicle.seats
        };
      }
    }

    // 4. Format lastLocation from GeoJSON
    let lastLocation = null;
    if (user.location?.coordinates && user.location.coordinates.length === 2) {
      lastLocation = {
        lng: user.location.coordinates[0],
        lat: user.location.coordinates[1],
        updatedAt: Date.now(),
      };
    }

    // 5. Attach complete user data to socket.auth
    (socket as any).auth = {
      _id: user._id.toString(),
      email: user.email,
      role: user.role,
      name: user.name,
      phone: user.phone,
      photo: user.profileImage,
      vehicle: vehicleInfo,
      lastLocation: lastLocation,
      avgRating: user.avgRating,
    };

    next();
  } catch (err) {
    console.error('Socket auth error:', err);
    next(new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Authentication failed'));
  }
};