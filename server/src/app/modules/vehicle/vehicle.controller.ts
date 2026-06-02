import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { VehicleService } from './vehicle.service';

const addMultipleCar = catchAsync(async (req, res) => {
  const result = await VehicleService.addMultipleCars(req.user.userId, req.body);
  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'Car added successfully',
    data: result,
  });
});

const addACar = catchAsync(async (req, res) => {
  const result = await VehicleService.addACar(req.user.userId, req.body);
  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'Car added successfully',
    data: result,
  });
});

const getMyCars = catchAsync(async (req, res) => {
  const result = await VehicleService.getMyCars(req.user.userId);
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Cars retrieved successfully',
    data: result,
  });
});

const updateACar = catchAsync(async (req, res) => {
  const result = await VehicleService.updateACar(
    req.user.userId,
    req.params.id as string,
    req.body,
  );
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Car updated successfully',
    data: result,
  });
});

const setAsDefault = catchAsync(async (req, res) => {
  const result = await VehicleService.setAsDefault(req.user.userId, req.params.id as string);
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Default car set successfully',
    data: result,
  });
});

const deleteACar = catchAsync(async (req, res) => {
  await VehicleService.deleteACar(req.user.userId, req.params.id as string);
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Car deleted successfully',
  });
});

export const VehicleController = {
  addMultipleCar,
  addACar,
  getMyCars,
  updateACar,
  setAsDefault,
  deleteACar,
};
