import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { StatusCodes } from 'http-status-codes';
import { SupportService } from './support.service';

const create = catchAsync(async (req, res) => {
  const result = await SupportService.create(req.user.userId, req.body);
  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'Support submitted successfully',
    data: result,
  });
});

const getAll = catchAsync(async (req, res) => {
  const result = await SupportService.getAll(req.query);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Support fetched successfully',
    pagination: result.meta,
    data: result.data,
  });
});

const sentSupportMessage = catchAsync(async (req, res) => {
  const result = await SupportService.sentSupportMessage(
    req.params.id as string,
    req.body
  );

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Support updated successfully',
    data: result,
  });
});

const changeStatus = catchAsync(async (req, res) => {
  const result = await SupportService.changeStatus(req.params.id as string, req.body);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Support status changed successfully',
    data: result
  });
});

const remove = catchAsync(async (req, res) => {
  await SupportService.remove(req.params.id as string);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Support deleted successfully',
  });
});

export const SupportController = {
  create,
  getAll,
  sentSupportMessage,
  changeStatus,
  remove,
};
