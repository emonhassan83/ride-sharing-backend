import { z } from 'zod'

const sendMessageValidation = z.object({
  body: z.object({
    chat: z.string({ message: 'chat id is required' }).optional(),
    text: z
      .string({ message: 'text is required' })
      .optional(),
    receiver: z.string({ message: 'receiver id is required' }),
    seen: z.boolean().default(false),
  }),
})

const updateMessageValidation = z.object({
  body: z.object({
    text: z
      .string({ message: 'text is required' })
      .optional()
  }),
})

export const messagesValidation = {
  sendMessageValidation,
  updateMessageValidation,
}