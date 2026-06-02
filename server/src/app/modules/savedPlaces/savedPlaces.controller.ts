import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { SavedPlaceService } from './savedPlaces.service';

const createUserLocation = catchAsync(async (req: Request, res: Response) => {
  const result = await SavedPlaceService.createSavedPlace(
    req.user.userId,
    req.body
  );

  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'Location saved successfully',
    data: result,
  });
});

const getMyLocations = catchAsync(async (req: Request, res: Response) => {
  const result = await SavedPlaceService.getMySavedPlaces(req.user.userId);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'My locations retrieved successfully',
    data: result,
  });
});

const togglePinSavedLocation = catchAsync(async (req: Request, res: Response) => {
  const result = await SavedPlaceService.togglePinSavedLocation(
    req.user.userId,
    req.params.id as string
  );

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Location updated successfully',
    data: result,
  });
});

const updateUserLocation = catchAsync(async (req: Request, res: Response) => {
  const result = await SavedPlaceService.updateSavedPlace(
    req.user.userId,
    req.params.id as string,
    req.body
  );

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Location updated successfully',
    data: result,
  });
});

const deleteUserLocation = catchAsync(async (req: Request, res: Response) => {
  await SavedPlaceService.deleteSavedPlace(req.user.userId, req.params.id as string);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Location deleted successfully',
  });
});

export const SavedPlacesController = {
  createUserLocation,
  getMyLocations,
  togglePinSavedLocation,
  updateUserLocation,
  deleteUserLocation,
};
