import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { RideService } from './ride.service';

const getAllRides = catchAsync(async (req: Request, res: Response) => {
  const result = await RideService.getAllIntoDB(req.query);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Available ride retrieved',
    pagination: result.meta,
    data: result.result,
  });
});

const getDriverRides = catchAsync(async (req: Request, res: Response) => {
  const result = await RideService.getDriverRides(
    req.user?.userId,
    req.query
  );

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'My ride requests retrieved successfully',
    pagination: result.meta,
    data: result.result,
  });
});

const getRiderRides = catchAsync(async (req: Request, res: Response) => {
  const result = await RideService.getRiderRides(
    req.user?.userId,
    req.query
  );

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'My ride requests retrieved successfully',
    pagination: result.meta,
    data: result.result,
  });
});

const getARide = catchAsync(async (req: Request, res: Response) => {
  const result = await RideService.getRideById(req.params.id as string);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Ride details retrieved successfully',
    data: result,
  });
});

const getDriverInvoice = catchAsync(async (req: Request, res: Response) => {
  const result = await RideService.getDriverMonthlyInvoice(
    {
      userId: req.user?.userId as string,
      role: req.user?.role as string,
    },
    {
      year: Number(req.query.year),
      month: Number(req.query.month),
      driverId: req.query.driverId as string | undefined,
    },
  );

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Driver invoice data fetched successfully',
    data: result,
  });
});

export const RideController = {
  getAllRides,
  getDriverRides,
  getRiderRides,
  getARide,
  getDriverInvoice,
};
