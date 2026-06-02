import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { ProviderService } from './provider.service';

const insertIntoDB = catchAsync(async (req, res) => {
  const result = await ProviderService.insertIntoDB(req.user.userId, req.body);

  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'Verification created successfully',
    data: result,
  });
});

// Get all Verification
const getAllIntoDB = catchAsync(async (req, res) => {
  const result = await ProviderService.getAllIntoDB(req.query);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Verifications retrieved successfully',
    pagination: result.meta,
    data: result.data,
  });
});

// Get Verification by ID
const getAIntoDB = catchAsync(async (req, res) => {
  const result = await ProviderService.getAIntoDB(req.params.id as string);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Verification retrieved successfully',
    data: result,
  });
});

// Update Verification
const updateAIntoDB = catchAsync(async (req, res) => {
  const result = await ProviderService.updateStatusIntoDB(
    req.params.id as string,
    req.body,
  );

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Verification updated successfully',
    data: result,
  });
});

export const ProviderController = {
  insertIntoDB,
  getAllIntoDB,
  getAIntoDB,
  updateAIntoDB,
};
