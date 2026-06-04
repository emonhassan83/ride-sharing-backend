import catchAsync from '../../utils/catchAsync';
import httpStatus from 'http-status';
import sendResponse from '../../utils/sendResponse';
import { WithdrawService } from './withdraw.service';

const addWithdraw = catchAsync(async (req, res) => {
  const result = await WithdrawService.addWithdraw(req.body, req.user.userId);

  sendResponse(res, {
    code: httpStatus.CREATED,
    message: 'Withdraw insert successfully!',
    data: result,
  });
});

const getMyWithdraws = catchAsync(async (req, res) => {
  const result = await WithdrawService.getMyWithdrawsFromDB(
    req.query,
    req.user.userId
  );

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'My withdraws retrieved successfully!',
    pagination: result.meta,
    data: result.result,
  });
});

const getAllWithdraw = catchAsync(async (req, res) => {
  const result = await WithdrawService.getAllWithdrawsFromDB(req.query);

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'All Withdraw retrieved successfully!',
    pagination: result.meta,
    data: result.result,
  });
});

const getAWithdraw = catchAsync(async (req, res) => {
  const result = await WithdrawService.getAWithdrawFromDB(
    req.params.id as string
  );

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Withdraw retrieved successfully!',
    data: result,
  });
});

const updateWithdraw = catchAsync(async (req, res) => {
  const result = await WithdrawService.updateWithdrawFromDB(
    req.params.id as string,
    req.body
  );

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Withdraw update successfully!',
    data: result,
  });
});

const stripeWebhook = catchAsync(async (req, res) => {
  const signature = req.headers['stripe-signature'] as string;
  if (!signature) {
    return res
      .status(httpStatus.BAD_REQUEST)
      .json({ message: 'Missing stripe-signature header' });
  }

  try {
    const result = await WithdrawService.handleStripeWebhook(
      req.body as Buffer,
      signature
    );
    sendResponse(res, {
      code: httpStatus.OK,
      message: 'Withdraw update successfully!',
      data: result,
    });
  } catch (error: any) {
    console.error('❌ Stripe webhook error:', error.message);
    return res.status(httpStatus.BAD_REQUEST).json({ message: error.message });
  }
});

export const WithdrawControllers = {
  addWithdraw,
  getAllWithdraw,
  getMyWithdraws,
  getAWithdraw,
  updateWithdraw,
  stripeWebhook,
};
