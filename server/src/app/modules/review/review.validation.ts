import { Types } from 'mongoose'
import { z } from 'zod'

const objectIdSchema = z.string().refine((val) => Types.ObjectId.isValid(val), {
  message: 'Invalid ObjectId format',
})

const createValidationSchema = z.object({
  body: z.object({
    user: objectIdSchema,
    comment: z.string({
      message: 'Reviews comment is Required',
    }),
    rating: z
      .number({
        message: 'Reviews rating is Required',
      })
      .min(1)
      .max(5),
  }),
})

export const ReviewsValidation = {
  createValidationSchema
}
