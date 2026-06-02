import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { StatusCodes } from 'http-status-codes';
import { UploadService } from './upload.service';

const multiple = catchAsync(async (req, res) => {
  const result = await UploadService.multiple(req.files as any[]);
  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'multiple uploaded successfully',
    data: result,
  });
});

const single = catchAsync(async (req, res) => {
  const result = await UploadService.single(req.file);
  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'single uploaded successfully',
    data: result,
  });
});

export const UploadController = {
  multiple,
  single,
};