import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import httpStatus from 'http-status';
import { CardServices } from './card.service';

const setupInitiate = catchAsync(async (req: Request, res: Response) => {
  const result = await CardServices.setupInitiate(req.body, req.user.userId);
  sendResponse(res, {
    code: httpStatus.OK,
    message: result.message,
    data: result,
  });
});

const getCardList = catchAsync(async (req: Request, res: Response) => {
  const result = await CardServices.getCardList(req.user?.userId);
  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Card list fetched successfully',
    data: result,
  });
});

const deleteCard = catchAsync(async (req: Request, res: Response) => {
  const result = await CardServices.deleteCard(
    req.params.cardId as string,
    req.user?.userId
  );
  sendResponse(res, {
    code: httpStatus.OK,
    message: result.message,
    data: result,
  });
});

const setDefaultCard = catchAsync(async (req: Request, res: Response) => {
  const result = await CardServices.setDefaultCard(
    req.body.paymentMethodId,
    req.user?.userId
  );
  sendResponse(res, {
    code: httpStatus.OK,
    message: result.message,
    data: result,
  });
});

export const CardController = {
  setupInitiate,
  getCardList,
  deleteCard,
  setDefaultCard,
};
