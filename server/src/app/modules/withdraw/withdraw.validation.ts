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
    manualTransferReference: z.string().trim().optional(),
  }),
});

export const WithdrawValidation = {
  updateValidationSchema,
  createValidationSchema,
};

