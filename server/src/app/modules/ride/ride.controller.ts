import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { RideService } from './ride.service';

const findNearbyAvailableDrivers = catchAsync(async (req: Request, res: Response) => {
  const result = await RideService.findNearbyAvailableDrivers(req.body, req.query);

  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'Nearby rider find successfully!',
    data: result,
  });
});

const createRideRequest = catchAsync(async (req: Request, res: Response) => {
  const result = await RideService.createRideRequest(req.user?.userId, req.body);

  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'Ride request created successfully',
    data: result,
  });
});

const getMyRides = catchAsync(async (req: Request, res: Response) => {
  const result = await RideService.getMyRideRequests(req.user?.userId, req.query.status as string);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'My ride requests retrieved successfully',
    data: result,
  });
});

const getARides = catchAsync(async (req: Request, res: Response) => {
  const result = await RideService.getRideById(req.params.id as string);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'My ride requests retrieved successfully',
    data: result,
  });
});

const getAvailableRequestsForDriver = catchAsync(async (req: Request, res: Response) => {
  const result = await RideService.getAvailableRideRequests(req.user?.userId, req.query);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Available ride requests retrieved',
    data: result,
  });
});

export const RideController = {
  findNearbyAvailableDrivers,
  createRideRequest,
  getMyRides,
  getARides,
  getAvailableRequestsForDriver
};