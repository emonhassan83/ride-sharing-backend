import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { RideService } from './ride.service';

const getAllRides = catchAsync(async (req: Request, res: Response) => {
  const result = await RideService.getAllIntoDB(req.user?.userId, req.query);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Available ride requests retrieved',
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

export const RideController = {
  getAllRides,
  getMyRides,
  getARides,
};