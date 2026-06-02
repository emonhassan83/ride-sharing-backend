import { z } from 'zod'

const connectValidationSchema = z.object({
  body: z.object({
    stripeAccountId: z.string({
      required_error: 'Stripe Account ID is required!',
    }),
  }),
})

export const StripeValidation = {
  connectValidationSchema,
}
