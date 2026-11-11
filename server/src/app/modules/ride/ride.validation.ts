import { z } from 'zod';

export const driverInvoiceQueryZodSchema = z.object({
  query: z.object({
    year: z.coerce
      .number({ message: 'year is required' })
      .int()
      .min(2020)
      .max(2100),
    month: z.coerce
      .number({ message: 'month is required' })
      .int()
      .min(1)
      .max(12),
    driverId: z.string().min(1).optional(),
  }),
});

export const sendStartOtpZodSchema = z.object({
  body: z.object({
    rideId: z.string({ message: 'rideId is required' }).min(1, 'rideId is required'),
    passengerId: z.string({ message: 'passengerId is required' }).min(1, 'passengerId is required'),
  }),
});

export const verifyStartOtpZodSchema = z.object({
  body: z.object({
    rideId: z.string({ message: 'rideId is required' }).min(1, 'rideId is required'),
    passengerId: z.string({ message: 'passengerId is required' }).min(1, 'passengerId is required'),
    otp: z.string({ message: 'otp is required' }).min(4, 'otp must be at least 4 digits').max(8),
  }),
});

export const RideValidation = {
  driverInvoiceQueryZodSchema,
  sendStartOtpZodSchema,
  verifyStartOtpZodSchema,
};
