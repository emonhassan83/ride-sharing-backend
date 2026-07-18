import mongoose from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { ILocationHistory, ILocationPoint } from './locationHistory.interface';
import { LocationHistory } from './locationHistory.model';

const validateObjectId = (id: string, label = 'ID') => {
  if (!mongoose.Types.ObjectId.isValid(id))
    throw new ApiError(StatusCodes.BAD_REQUEST, `Invalid ${label}`);
};

// ── Get location history by rideId (dispute resolution) ───────────────────────
const getLocationHistoryByRideId = async (rideId: string): Promise<ILocationHistory> => {
  validateObjectId(rideId, 'ride ID');

  const history = await LocationHistory.findOne({ rideId })
    .populate('driverId', 'name email phone profileImage')
    .populate('userId', 'name email phone profileImage')
    .lean();

  if (!history)
    throw new ApiError(StatusCodes.NOT_FOUND, 'Location history not found');

  return history as ILocationHistory;
};

// ── Get driver location history for date range (admin/analytics) ──────────────
const getDriverLocationHistory = async (
  driverId: string,
  query: Record<string, any>,
) => {
  validateObjectId(driverId, 'driver ID');

  const { startDate: rawStart, endDate: rawEnd } = query;

  if (!rawStart || !rawEnd)
    throw new ApiError(StatusCodes.BAD_REQUEST, 'startDate and endDate are required');

  const startDate = new Date(rawStart);
  const endDate = new Date(rawEnd);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()))
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Invalid date format');

  if (startDate > endDate)
    throw new ApiError(StatusCodes.BAD_REQUEST, 'startDate cannot be after endDate');

  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const skip = (page - 1) * limit;

  const filters = { driverId, startTime: { $gte: startDate, $lte: endDate } };

  const [data, total] = await Promise.all([
    LocationHistory.find(filters).sort({ startTime: -1 }).skip(skip).limit(limit).lean(),
    LocationHistory.countDocuments(filters),
  ]);

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPage: Math.ceil(total / limit),
    },
  };
};

export const LocationHistoryService = {
  getLocationHistoryByRideId,
  getDriverLocationHistory
};