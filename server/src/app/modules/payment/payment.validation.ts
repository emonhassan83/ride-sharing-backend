import { Types } from 'mongoose'
import { z } from 'zod'

const objectIdSchema = z.string().refine((val) => Types.ObjectId.isValid(val), {
  message: 'Invalid ObjectId',
})

const createValidationSchema = z.object({
  body: z.object({
    booking: objectIdSchema,
    paymentMethodId: z.string().optional(),
  }),
})

const confirmPaymentSchema = z.object({
  body: z.object({
    paymentIntentId: z.string({ message: 'Payment Intent ID is required!' }),
    paymentId: objectIdSchema.optional(),
  }),
})

export const PaymentValidation = {
  createValidationSchema,
  confirmPaymentSchema,
}


