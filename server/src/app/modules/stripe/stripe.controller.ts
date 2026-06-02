import { Request, Response } from 'express'
import catchAsync from '../../utils/catchAsync'
// import { stripeService } from './stripe.service'
import sendResponse from '../../utils/sendResponse'
import httpStatus from 'http-status'
import StripeService from '../../config/stripe.config'
import { stripeService } from './stripe.service'

const stripLinkAccount = catchAsync(async (req: Request, res: Response) => {
  const result = await stripeService.stripLinkAccount(req?.user?.userId)
  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Account creation URL generated successfully.',
    data: result,
  })
})

// Connect Existing Account
const connectExistingStripeAccount = catchAsync(async (req: Request, res: Response) => {
  const result = await StripeService.connectExistingAccount(req.user.userId, req.body);

  sendResponse(res, {
    code: httpStatus.OK,
    message: result.message,
    data: result,
  });
});

// checked stripe connected
const checkStripeConnected = catchAsync(async (req: Request, res: Response) => {
  const result = await stripeService.checkStripeConnected(req?.user?.userId)
  
  sendResponse(res, {
    code: httpStatus.OK,
    message: result.isConnected
      ? 'Stripe account is connected.'
      : 'Stripe account is not connected.',
    data: result,
  })
})

const handleStripeOAuth = catchAsync(async (req: Request, res: Response) => {
  await stripeService.handleStripeOAuth(req.query, req.user?.userId)

  // Redirect to home or a specific page after successful OAuth
  res.redirect('/')
})

const refresh = catchAsync(async (req: Request, res: Response) => {
  const result = await stripeService.refresh(req.params?.id as string, req.query)

  // Remove sendResponse after res.redirect to avoid setting headers twice
  res.redirect(result)
})

const returnUrl = catchAsync(async (req: Request, res: Response) => {
  const result = await stripeService.returnUrl(req.query)
  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Stripe account connected successfully',
    data: result,
  })
})

// Step 5: Get Stripe account status
const getStripeAccountStatus = catchAsync(
  async (req: Request, res: Response) => {
    const result = await stripeService.getStripeAccountStatus(req?.user?.userId)

    sendResponse(res, {

      code: httpStatus.OK,
      message: 'Stripe account status retrieved',
      data: result,
    })
  },
)

// Step 6: Disconnect Stripe account
const disconnectStripe = catchAsync(async (req: Request, res: Response) => {
  const result = await stripeService.disconnectStripe(req?.user?.userId)

  sendResponse(res, {
    code: httpStatus.OK,
    message: result.message,
    data: result,
  })
})

export const stripeController = {
  stripLinkAccount,
  connectExistingStripeAccount,
  checkStripeConnected,
  handleStripeOAuth,
  refresh,
  returnUrl,
  getStripeAccountStatus,
  disconnectStripe,
}
