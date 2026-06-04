import { Types } from 'mongoose'
import { z } from 'zod'
import { CHAT_STATUS } from './chat.constants'

// reusable ObjectId validator
const objectIdSchema = z.string().refine((val) => Types.ObjectId.isValid(val), {
  message: 'Invalid ObjectId format',
})

const createValidation = z.object({
  body: z.object({
    booking: objectIdSchema,
    participants: z
      .array(z.string())
      .length(2, { message: 'must be add in the array user and receiver id' }),
  }),
})

const updateValidation = z.object({
  body: z.object({
    name: z.string({
      message: 'Chat name is required!',
    }),
    status: z.enum(Object.values(CHAT_STATUS) as [string, ...string[]], {
      message: 'Invalid chat status.',
    }).optional(),
  }),
})

export const ChatValidation = {
  createValidation,
  updateValidation,
}
