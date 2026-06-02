import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { SettingService } from './settings.service';

const getSetting = catchAsync(async (req, res) => {
  const result = await SettingService.getSetting(req.query.key as string);
  sendResponse(res, { code: StatusCodes.OK, data: result });
});

const getSettingGenerals = catchAsync(async (req, res) => {
  const result = await SettingService.getSettingGenerals();
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'General settings retrieved successfully',
    data: result,
  });
});

const createOrUpdate = catchAsync(async (req, res) => {
  const result = await SettingService.createOrUpdate(
    req.params.key as string,
    req.body,
  );
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Setting updated successfully',
    data: result,
  });
});

const updateGenerals = catchAsync(async (req, res) => {
  await SettingService.updateGenerals(req.body);
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'General settings updated successfully',
  });
});

export const SettingController = {
  getSetting,
  getSettingGenerals,
  createOrUpdate,
  updateGenerals,
};
