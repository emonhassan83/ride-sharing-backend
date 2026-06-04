import mongoose from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { calculateDistance, calculateDuration } from '../../utils/location.utils';
import { ILocationHistory, ILocationPoint } from './locationHistory.interface';
import { LocationHistory } from './locationHistory.model';

const validateObjectId = (id: string, label = 'ID') => {
  if (!mongoose.Types.ObjectId.isValid(id))
    throw new ApiError(StatusCodes.BAD_REQUEST, `Invalid ${label}`);
};

// ── Create location history after trip completion ──────────────────────────────
const createLocationHistory = async (
  rideId: string,
  driverId: string,
  userId: string,
  locations: ILocationPoint[],
  startTime: Date,
  endTime: Date,
): Promise<ILocationHistory> => {
  if (!locations.length)
    throw new ApiError(StatusCodes.BAD_REQUEST, 'At least one location point is required');

  let totalDistance = 0;
  let maxSpeed = 0;
  let totalSpeed = 0;

  for (let i = 1; i < locations.length; i++) {
    totalDistance += calculateDistance(
      { lat: locations[i - 1].lat, lng: locations[i - 1].lng },
      { lat: locations[i].lat, lng: locations[i].lng },
    );
    if (locations[i].speed > maxSpeed) maxSpeed = locations[i].speed;
    totalSpeed += locations[i].speed;
  }

  const averageSpeed = totalSpeed / locations.length;
  const totalDuration = calculateDuration(locations);

  return await LocationHistory.create({
    rideId,
    driverId,
    passengerIds: [userId],
    locations,
    startTime,
    endTime,
    totalDistance,
    totalDuration,
    averageSpeed,
    maxSpeed,
  });
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

// ── Get ride route points for map display ─────────────────────────────────────
const getRideRoute = async (rideId: string): Promise<ILocationPoint[]> => {
  validateObjectId(rideId, 'ride ID');

  const history = await LocationHistory.findOne({ rideId }).select('locations').lean();
  if (!history)
    throw new ApiError(StatusCodes.NOT_FOUND, 'Ride route not found');

  return history.locations;
};

// ── Delete old location history (cron job) ────────────────────────────────────
const deleteOldLocationHistory = async (daysOld: number = 90): Promise<number> => {
  if (daysOld < 1)
    throw new ApiError(StatusCodes.BAD_REQUEST, 'daysOld must be at least 1');

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  const result = await LocationHistory.deleteMany({ startTime: { $lt: cutoffDate } });
  return result.deletedCount;
};

export const LocationHistoryService = {
  createLocationHistory,
  getLocationHistoryByRideId,
  getDriverLocationHistory,
  getRideRoute,
  deleteOldLocationHistory,
};