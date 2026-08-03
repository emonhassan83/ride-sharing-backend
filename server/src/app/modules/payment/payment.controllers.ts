import catchAsync from '../../utils/catchAsync'
import httpStatus from 'http-status'
import sendResponse from '../../utils/sendResponse'
import { PaymentService } from './payment.service'

const checkout = catchAsync(async (req, res) => {
  const result = await PaymentService.createPaymentIntent(req.body)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Payment intent created successfully',
    data: result,
  })
})

const confirmPayment = catchAsync(async (req, res) => {
  const result = await PaymentService.confirmPayment(req.body)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'payment successful',
    data: result,
  })
})

const payWithWallet = catchAsync(async (req, res) => {
  const result = await PaymentService.payWithWallet({
    booking: req.body.booking,
    user: req.user.userId,
  });

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'payment successful',
    data: result,
  })
});

const getAllPayments = catchAsync(async (req, res) => {
  const result = await PaymentService.getAllPaymentsFromDB(req.query)

  sendResponse(res, {
    code: 200,
    message: 'All payments retrieved successfully!',
    pagination: result.meta,
    data: result.data,
  })
})

const getDashboardData = catchAsync(async (req, res) => {})

const getAPayment = catchAsync(async (req, res) => {
  const result = await PaymentService.getAPaymentsFromDB(req.params.id as string)

  sendResponse(res, {
    code: 200,
    message: 'Payment retrieved successfully!',
    data: result,
  })
})

const getAPaymentByBookingId = catchAsync(async (req, res) => {
  const query = {
    ...req.query,
    booking: req.params.bookingId,
  }
  const result = await PaymentService.getAllPaymentsFromDB(query)

  sendResponse(res, {
    code: 200,
    message: 'Payment retrieved successfully!',
    data: result,
  })
})

const refundPayment = catchAsync(async (req, res) => {
  const result = await PaymentService.refundPayment(req.body)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Payment refund successfully!',
    data: result,
  })
})

export const PaymentControllers = {
  checkout,
  confirmPayment,
  payWithWallet,
  getAllPayments,
  getDashboardData,
  getAPayment,
  getAPaymentByBookingId,
  refundPayment,
}

