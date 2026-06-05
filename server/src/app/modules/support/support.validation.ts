import { z } from 'zod';
import { SUPPORT_STATUS } from './support.constant';

// Create Support / Report
const createSupportZodSchema = z.object({
  body: z.object({
    name: z
      .string()
      .min(2, {message: 'Name must be at least 2 characters'})
      .max(100, {message: 'Name is too long'}),

    phone: z
      .string()
      .min(6, { message: 'Contact number must be at least 6 digits long' })
      .max(15, { message: 'Contact number must be at most 15 digits long' }),

    booking: z
      .string()
      .regex(/^[0-9a-fA-F]{24}$/, { message: 'Invalid Job ID' })
      .optional()
      .nullable(),

    reason: z
      .string()
      .min(10, { message: 'Reason must be at least 10 characters long' })
      .max(1000, { message: 'Reason is too long' }),
  }),
});

const sentMessageValidationSchema = z.object({
  body: z.object({
    subject: z.string().min(3, { message: 'subject must be at least 3 characters' }),
    messages: z.string({ message: 'Support messages is required' }),
  }),
});

export const SupportValidation = {
  createSupportZodSchema,
  sentMessageValidationSchema,
};
