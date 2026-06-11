import { z } from 'zod';

const setupInitiateSchema = z.object({
  body: z.object({
    paymentMethodId: z.string({ message: 'Payment Method ID is required!' })
  }),
});

const setDefaultCardSchema = z.object({
  body: z.object({
    paymentMethodId: z.string({ message: 'Payment Method ID is required!' }),
  }),
});

export const CardValidation = {
  setupInitiateSchema,
  setDefaultCardSchema,
};