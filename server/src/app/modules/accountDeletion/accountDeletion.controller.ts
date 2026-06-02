import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { AccountDeletionService } from './accountDeletion.service';

const getAllDeletions = catchAsync(async (req: Request, res: Response) => {
  const result = await AccountDeletionService.getAllDeletions(req.query);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'All account deletions retrieved',
    data: result,
  });
});

const getSingleDeletion = catchAsync(async (req: Request, res: Response) => {
  const result = await AccountDeletionService.getSingleDeletion(req.params.id as string);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Deletion record retrieved successfully',
    data: result,
  });
});

const deleteDeletionRecord = catchAsync(async (req: Request, res: Response) => {
  await AccountDeletionService.deleteDeletionRecord(req.params.id as string);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Deletion record deleted successfully',
  });
});

export const AccountDeletionController = {
  getAllDeletions,
  getSingleDeletion,
  deleteDeletionRecord,
};