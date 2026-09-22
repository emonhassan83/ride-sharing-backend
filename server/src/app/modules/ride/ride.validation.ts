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

export const RideValidation = {
  driverInvoiceQueryZodSchema,
};
