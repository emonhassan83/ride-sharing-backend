import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { PassengerService } from './passenger.service';

// Create passenger (testing purpose)
const createPassenger = catchAsync(async (req: Request, res: Response) => {
  const result = await PassengerService.createPassenger(req.user?.userId, req.body);

  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'Passenger added successfully',
    data: result,
  });
});

// Get all passengers by rideId
const getPassengersByRide = catchAsync(async (req: Request, res: Response) => {
  const result = await PassengerService.getPassengersByRide(req.params.rideId as string);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Passengers retrieved successfully',
    data: result,
  });
});

// Get single passenger by passengerId
const getAPassenger = catchAsync(async (req: Request, res: Response) => {
  const result = await PassengerService.getPassengerById(req.params.id as string);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Passenger retrieved successfully',
    data: result,
  });
});

export const PassengerController = {
  createPassenger,
  getPassengersByRide,
  getAPassenger,
};
