import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { BookingService } from './booking.service';

const getAllBookings = catchAsync(async (req: Request, res: Response) => {
  const result = await BookingService.getAllBookings(req.query);
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'All bookings retrieved successfully',
    data: result.data,
    pagination: result.meta
  });
});

const getMyBookings = catchAsync(async (req: Request, res: Response) => {
  const result = await BookingService.getMyBookings(req.user.userId, req.query);

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'My bookings retrieved successfully',
    data: result.data,
    pagination: result.meta
  });
});

const getBooking = catchAsync(async (req: Request, res: Response) => {
  const result = await BookingService.getBookingById(req.params.id as string);
  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Booking retrieved successfully',
    data: result,
  });
});

const updateBookingStatus = catchAsync(async (req: Request, res: Response) => {
  const result = await BookingService.updateBookingStatus(
    req.params.id as string,
    req.body
  );

  sendResponse(res, {
    code: StatusCodes.OK,
    message: 'Booking status updated successfully',
    data: result,
  });
});

export const BookingController = {
  getAllBookings,
  getMyBookings,
  getBooking,
  updateBookingStatus,
};