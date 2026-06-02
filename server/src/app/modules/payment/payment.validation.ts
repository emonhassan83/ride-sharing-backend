import { Types } from 'mongoose'
import { z } from 'zod'

const objectIdSchema = z.string().refine((val) => Types.ObjectId.isValid(val), {
  message: 'Invalid ObjectId',
})

const createValidationSchema = z.object({
  body: z.object({
    user: objectIdSchema,
    booking: objectIdSchema,
  }),
})

export const PaymentValidation = {
  createValidationSchema
}

