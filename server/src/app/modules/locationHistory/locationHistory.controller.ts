import { LocationHistoryService } from './locationHistory.service';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { StatusCodes } from 'http-status-codes';

const getLocationHistoryByRide = catchAsync(async (req, res) => {
  const result = await LocationHistoryService.getLocationHistoryByRideId(req.params.rideId as string);
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Location history retrieved successfully',
    data: result,
  });
});

const getDriverLocationHistory = catchAsync(async (req, res) => {
  const result = await LocationHistoryService.getDriverLocationHistory(
    req.params.driverId as string,
    req.query,
  );
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Driver location history retrieved successfully',
    data: result.data,
    pagination: result.pagination,
  });
});

export const LocationHistoryController = {
  getLocationHistoryByRide,
  getDriverLocationHistory,
};