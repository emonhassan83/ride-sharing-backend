import { z } from 'zod';
import { WITHDRAW_STATUS } from './withdraw.constant';

const createValidationSchema = z.object({
  body: z.object({
    amount: z.number({ message: 'Amount must be a number' }).positive(),
  }),
});

const updateValidationSchema = z.object({
  body: z.object({
    status: z.enum(Object.values(WITHDRAW_STATUS) as [string, ...string[]], {
      message: 'Withdraw status is required!',
    }),
    note: z.string().optional(),
  }),
});

const myRequestsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    status: z.enum(Object.values(WITHDRAW_STATUS) as [string, ...string[]]).optional(),
  }),
});

export const WithdrawValidation = {
  myRequestsQuerySchema,
  updateValidationSchema,
  createValidationSchema,
};

