import { z } from 'zod'
import { REFUND_STATUS } from './refund.constant'

const updateValidationSchema = z.object({
  body: z.object({
    status: z.enum(Object.values(REFUND_STATUS) as [string, ...string[]], {
      required_error: 'User status is required!',
    }),
    note: z.string().optional(),
  }),
})

export const RefundValidation = {
  updateValidationSchema,
}
