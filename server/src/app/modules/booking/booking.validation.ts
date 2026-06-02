import { z } from 'zod';
import { BOOKING_STATUS } from './booking.constant';

export const updateBookingStatusZodSchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Booking ID is required'),
  }),
  body: z.object({
    bookingStatus: z.enum(Object.values(BOOKING_STATUS) as [string, ...string[]]).optional(),
    cancellationReason: z.string().optional(),
  }),
});

export const BookingValidation = {
  updateBookingStatusZodSchema,
};