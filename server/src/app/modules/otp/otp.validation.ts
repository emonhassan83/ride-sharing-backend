import { z } from 'zod';

const verifyOtpZodSchema = z.object({
  body: z.object({
    otp: z
      .string({ required_error: 'otp is required' })
      .length(6, { message: 'otp must be exactly 6 characters long' }),
  }),
});

const resentOtpInEmail = z.object({
  body: z.object({
    email: z
      .string({
        required_error: 'Email is required',
      })
      .email(),
  }),
});

const resentOtpInPhone = z.object({
  body: z.object({
    countryCode: z
      .string({ required_error: 'Country code is required!' })
      .min(1, 'Country code cannot be empty.'),
    phone: z
      .string({
        required_error: 'Phone number is required',
      })
      .min(6, { message: 'Contact number must be at least 6 digits long' })
      .max(15, { message: 'Contact number must be at most 15 digits long' }),
  }),
});

export const resentOtpValidations = {
  resentOtpInEmail,
  verifyOtpZodSchema,
  resentOtpInPhone,
};
