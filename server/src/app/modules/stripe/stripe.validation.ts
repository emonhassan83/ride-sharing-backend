import { z } from 'zod'

const connectValidationSchema = z.object({
  body: z.object({
    stripeAccountId: z.string({
      message: 'Stripe Account ID is required!',
    }),
  }),
})

export const StripeValidation = {
  connectValidationSchema,
}
