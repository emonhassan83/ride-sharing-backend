import { Types } from 'mongoose';
import { z } from 'zod';
import { modeType } from './notification.interface';

const objectIdSchema = z.string().refine((val) => Types.ObjectId.isValid(val), {
  message: 'Invalid ObjectId format',
});

// POST /notification is admin-only; the receiver must be given explicitly and
// unknown keys (read, isDeleted, date, ...) are rejected.
const createValidationSchema = z.object({
  body: z
    .object({
      receiver: objectIdSchema,
      message: z.string().trim().min(1).max(500),
      description: z.string().trim().max(2000).optional(),
      reference: objectIdSchema.optional(),
      modelType: z.enum(Object.values(modeType) as [string, ...string[]]).optional(),
      type: z.string().trim().max(100).optional(),
      data: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
});

export const NotificationValidation = {
  createValidationSchema,
};
