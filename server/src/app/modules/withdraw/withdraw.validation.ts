import { z } from 'zod'
import { WITHDRAW_STATUS } from './withdraw.constant'
import { Types } from 'mongoose'

// reusable ObjectId validator
const objectIdSchema = z.string().refine((val) => Types.ObjectId.isValid(val), {
  message: 'Invalid ObjectId format',
})

const createValidationSchema = z.object({
  body: z.object({
    booking: objectIdSchema,
  }),
})

const updateValidationSchema = z.object({
  body: z.object({
    status: z.enum(Object.values(WITHDRAW_STATUS) as [string, ...string[]], {
      message: 'Withdraw status is required!',
    }),
    note: z.string().optional(),
  }),
})

export const WithdrawValidation = {
  updateValidationSchema,
  createValidationSchema,
}
