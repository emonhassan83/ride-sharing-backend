import mongoose, { Types } from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { IRiderHistory } from './riderHistory.interface';
import { RiderHistory } from './riderHistory.model';
import { LocationHistoryService } from '../locationHistory/locationHistory.service';

const validateObjectId = (id: string, label = 'ID') => {
  if (!mongoose.Types.ObjectId.isValid(id))
    throw new ApiError(StatusCodes.BAD_REQUEST, `Invalid ${label}`);
};

const parseOptionalDate = (val: any): Date | undefined => {
  if (!val) return undefined;
  const d = new Date(val);
  if (isNaN(d.getTime())) throw new ApiError(StatusCodes.BAD_REQUEST, `Invalid date: ${val}`);
  return d;
};

// ── Create rider history after trip completion ─────────────────────────────────
const createRiderHistory = async (data: Partial<IRiderHistory>): Promise<IRiderHistory> => {
  return await RiderHistory.create(data);
};

// ── Get rider trip history with pagination and filters ────────────────────────
const getRiderTripHistory = async (userId: string, query: Record<string, any>) => {
  validateObjectId(userId, 'user ID');

  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const skip  = (page - 1) * limit;

  const fromDate = parseOptionalDate(query.fromDate);
  const toDate   = parseOptionalDate(query.toDate);
  const minFare  = query.minFare  ? parseFloat(query.minFare)  : undefined;
  const maxFare  = query.maxFare  ? parseFloat(query.maxFare)  : undefined;

  if (fromDate && toDate && fromDate > toDate)
    throw new ApiError(StatusCodes.BAD_REQUEST, 'fromDate cannot be after toDate');

  if (minFare != null && maxFare != null && minFare > maxFare)
    throw new ApiError(StatusCodes.BAD_REQUEST, 'minFare cannot be greater than maxFare');

  const filters: Record<string, any> = { userId };

  if (query.status) filters.status = query.status;

  if (fromDate || toDate) {
    filters['summary.date'] = {};
    if (fromDate) filters['summary.date'].$gte = fromDate;
    if (toDate)   filters['summary.date'].$lte = toDate;
  }

  if (minFare != null || maxFare != null) {
    filters['summary.fare'] = {};
    if (minFare != null) filters['summary.fare'].$gte = minFare;
    if (maxFare != null) filters['summary.fare'].$lte = maxFare;
  }

  const [data, total, stats] = await Promise.all([
    RiderHistory.find(filters).sort({ 'summary.date': -1 }).skip(skip).limit(limit).lean(),
    RiderHistory.countDocuments(filters),
    getRiderStats(userId, { fromDate: query.fromDate, toDate: query.toDate }),
  ]);

  return {
    data,
    pagination: { page, limit, total, totalPage: Math.ceil(total / limit) },
    stats,
  };
};

// ── Get single ride details ────────────────────────────────────────────────────
const getRideDetails = async (rideId: string, userId: string) => {
  validateObjectId(rideId, 'ride ID');
  validateObjectId(userId, 'user ID');

  const ride = await RiderHistory.findOne({ rideId, userId }).lean();
  if (!ride) throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');

  return ride;
};

// ── Get ride route (ownership-checked) ───────────────────────────────────────
const getRideRoute = async (rideId: string, userId: string) => {
  const ride = await getRideDetails(rideId, userId); // throws if not found/owned

  const points = await LocationHistoryService.getRideRoute(rideId);

  return {
    pickup:      ride.summary.pickupAddress,
    destination: ride.summary.destinationAddress,
    points:      points ?? [],
  };
};


// ── Get rider stats ───────────────────────────────────────────────────────────
const getRiderStats = async (userId: string, query: Record<string, any> = {}) => {
  validateObjectId(userId, 'user ID');

  const fromDate = parseOptionalDate(query.fromDate);
  const toDate   = parseOptionalDate(query.toDate);

  const matchCondition: Record<string, any> = {
    userId: new Types.ObjectId(userId),
    status: 'completed',
  };

  if (fromDate || toDate) {
    matchCondition['summary.date'] = {};
    if (fromDate) matchCondition['summary.date'].$gte = fromDate;
    if (toDate)   matchCondition['summary.date'].$lte = toDate;
  }

  const [aggregation, favoriteRoute] = await Promise.all([
    RiderHistory.aggregate([
      { $match: matchCondition },
      {
        $group: {
          _id: null,
          totalRides:    { $sum: 1 },
          totalSpent:    { $sum: '$summary.fare' },
          totalDistance: { $sum: '$summary.distance' },
          averageRating: { $avg: '$rating.ratingGiven' },
        },
      },
    ]),

    RiderHistory.aggregate([
      { $match: { userId: new Types.ObjectId(userId), status: 'completed' } },
      {
        $group: {
          _id: { pickup: '$summary.pickupAddress', destination: '$summary.destinationAddress' },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]),
  ]);

  if (!aggregation.length) {
    return { totalRides: 0, totalSpent: 0, totalDistance: 0, averageRating: 0 };
  }

  return {
    totalRides:    aggregation[0].totalRides,
    totalSpent:    aggregation[0].totalSpent,
    totalDistance: aggregation[0].totalDistance,
    averageRating: aggregation[0].averageRating || 0,
    favoriteRoute: favoriteRoute[0]
      ? `${favoriteRoute[0]._id.pickup} → ${favoriteRoute[0]._id.destination}`
      : undefined,
  };
};

// ── Get monthly spending trend ────────────────────────────────────────────────
const getMonthlySpendingTrend = async (userId: string, query: Record<string, any>) => {
  validateObjectId(userId, 'user ID');

  const year = parseInt(query.year) || new Date().getFullYear();

  if (year < 2000 || year > new Date().getFullYear() + 1)
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Invalid year');

  return await RiderHistory.aggregate([
    {
      $match: {
        userId: new Types.ObjectId(userId),
        status: 'completed',
        'summary.date': { $gte: new Date(year, 0, 1), $lte: new Date(year, 11, 31) },
      },
    },
    {
      $group: {
        _id:        { month: { $month: '$summary.date' } },
        totalSpent: { $sum: '$summary.fare' },
        rideCount:  { $sum: 1 },
      },
    },
    { $sort: { '_id.month': 1 } },
  ]);
};

// ── Cancel ride history (refund cases) ───────────────────────────────────────
const cancelRideHistory = async (
  rideId: string,
  userId: string,
  reason: string,
  refundAmount?: number,
) => {
  validateObjectId(rideId, 'ride ID');

  if (!reason?.trim())
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Cancellation reason is required');

  const updateData: Record<string, any> = { status: 'cancelled', cancellationReason: reason };

  if (refundAmount != null) {
    if (refundAmount < 0) throw new ApiError(StatusCodes.BAD_REQUEST, 'Refund amount cannot be negative');
    updateData['payment.status'] = 'refunded';
    updateData['summary.fare']   = refundAmount;
  }

  const updated = await RiderHistory.findOneAndUpdate({ rideId, userId }, updateData, { new: true }).lean();
  if (!updated) throw new ApiError(StatusCodes.NOT_FOUND, 'Ride not found');

  return updated;
};

export const RiderHistoryService = {
  createRiderHistory,
  getRiderTripHistory,
  getRideDetails,
  getRideRoute,
  getRiderStats,
  getMonthlySpendingTrend,
  cancelRideHistory,
};