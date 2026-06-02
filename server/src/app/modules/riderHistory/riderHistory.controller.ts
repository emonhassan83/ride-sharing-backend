import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { StatusCodes } from 'http-status-codes';
import { RiderHistoryService } from './riderHistory.service';

const getTripHistory = catchAsync(async (req, res) => {
  const result = await RiderHistoryService.getRiderTripHistory(req.user._id, req.query);
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Trip history retrieved successfully',
    data: result.data,
    pagination: result.pagination,
    extra: { stats: result.stats },
  });
});

const getRideDetails = catchAsync(async (req, res) => {
  const result = await RiderHistoryService.getRideDetails(req.params.rideId as string, req.user._id);
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Ride details retrieved successfully',
    data: result,
  });
});

const getRideRoute = catchAsync(async (req, res) => {
  const result = await RiderHistoryService.getRideRoute(req.params.rideId as string, req.user._id);
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Ride route retrieved successfully',
    data: result,
  });
});


const getRiderStats = catchAsync(async (req, res) => {
  const result = await RiderHistoryService.getRiderStats(req.user._id, req.query);
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Rider stats retrieved successfully',
    data: result,
  });
});

const getMonthlyTrend = catchAsync(async (req, res) => {
  const result = await RiderHistoryService.getMonthlySpendingTrend(req.user._id, req.query);
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Monthly trend retrieved successfully',
    data: result,
  });
});

export const RiderHistoryController = {
  getTripHistory,
  getRideDetails,
  getRideRoute,
  getRiderStats,
  getMonthlyTrend,
};