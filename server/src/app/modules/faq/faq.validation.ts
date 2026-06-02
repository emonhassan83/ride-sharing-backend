import { z } from 'zod'
import { AUDIENCE } from './faq.constant'

const createValidationSchema = z.object({
  body: z.object({
    audience: z.enum(Object.values(AUDIENCE) as [string, ...string[]], {
      required_error: 'FAQ audience is required!',
    }),
    question: z.string({
      required_error: 'FAQ question is required!',
    }),
    answer: z.string({
      required_error: 'FAQ answer is required!',
    }),
  }),
})

const updateValidationSchema = z.object({
  body: z.object({
    audience: z.enum(Object.values(AUDIENCE) as [string, ...string[]], {
      required_error: 'FAQ audience is required!',
    })
      .optional(),
    question: z
      .string({
        required_error: 'FAQ question is required!',
      })
      .optional(),
    answer: z
      .string({
        required_error: 'FAQ answer is required!',
      })
      .optional(),
  }),
})

export const FaqValidation = {
  createValidationSchema,
  updateValidationSchema,
}
