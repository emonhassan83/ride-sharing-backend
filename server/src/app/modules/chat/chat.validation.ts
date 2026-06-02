import { Types } from 'mongoose'
import { z } from 'zod'

// reusable ObjectId validator
const objectIdSchema = z.string().refine((val) => Types.ObjectId.isValid(val), {
  message: 'Invalid ObjectId format',
})

const createValidation = z.object({
  body: z.object({
    booking: objectIdSchema,
    participants: z
      .array(z.string())
      .length(2, 'must be add in the array user and receiver id'),
  }),
})

const updateValidation = z.object({
  body: z.object({
    name: z.string({
      required_error: 'Chat name is required!',
    }),
    status: z.enum(['accepted', 'blocked']).optional(),
  }),
})

export const ChatValidation = {
  createValidation,
  updateValidation,
}
