import { z } from 'zod';
import { USER_ROLE } from '../user/user.constant';

const loginValidationSchema = z.object({
  body: z.object({
    email: z.string({
        message: 'Email is required.',
      })
      .email({ message: 'Invalid email address.' }),
    password: z
      .string({
        message: 'Password is required.',
      })
      .min(8, { message: 'Password must be at least 8 characters long.' }),
    fcmToken: z.string().optional(),
  }),
});

const loginWithPhoneValidationSchema = z.object({
  body: z.object({
    phone: z
      .string({ message: 'Phone number is required!' })
      .min(6, { message: 'Contact number must be at least 6 digits long' })
      .max(15, { message: 'Contact number must be at most 15 digits long' }),
    countryCode: z
      .string({ message: 'Country code is required!' })
      .min(1, { message: 'Country code cannot be empty.' }),
    fcmToken: z.string().optional(),
  }),
});

const verifyEmailValidationSchema = z.object({
  body: z.object({
    otp: z
      .string({
        message: 'One time code is required.',
      })
      .min(6, { message: 'One time code must be at least 6 characters long.' }),
    email: z
      .string({
        message: 'Email is required.',
      })
      .email({ message: 'Invalid email address.' }),
    token: z.string({
      message: 'Token is required.',
    }),
  }),
});

const forgotPasswordValidationSchema = z.object({
  body: z.object({
    email: z
      .string({
        message: 'Email is required.',
      })
      .email({ message: 'Invalid email address.' }),
  }),
});

const resetPasswordValidationSchema = z.object({
  body: z.object({
    password: z
      .string({
        message: 'Password is required.'
      })
      .min(8, { message: 'Password must be at least 8 characters long.' }),
    confirmPassword: z
      .string({
        message: 'Confirm Password is required.'
      })
      .min(8, { message: 'Password must be at least 8 characters long.' }),
  }),
});

const changePasswordValidationSchema = z.object({
  body: z.object({
    currentPassword: z
      .string({
        message: 'Old password is required.'
      })
      .min(8, { message: 'Old password must be at least 8 characters long.' }),
    password: z
      .string({
        message: 'New password is required.'
      })
      .min(8, { message: 'New password must be at least 8 characters long.' }),
    confirmPassword: z
      .string({
        message: 'Confirm Password is required.'
      })
      .min(8, { message: 'Confirm password must be at least 8 characters long.' }),
  }),
});

const googleZodValidationSchema = z.object({
  body: z.object({
    name: z
      .string({
        message: 'Name is required.'
      })
      .min(1, { message: 'Name cannot be empty.' }),
    email: z
      .string({
        message: 'Email is required.'
      })
      .email({ message: 'Invalid email address.' }),
    role: z.enum(Object.values(USER_ROLE) as [string, ...string[]], {
      message: 'Role is required.',
    }),
    token: z.string({
      message: 'token is required!',
    }),
    fcmToken: z.string().optional(),
    profileImage: z.string().optional(),
  }),
});

const appleZodValidationSchema = z.object({
  body: z.object({
    name: z
      .string({
        message: 'Name is required.'
      })
      .min(1, { message: 'Name cannot be empty.' }),
    email: z
      .string({
        message: 'Email is required.'
      })
      .email({ message: 'Invalid email address.' }),
    role: z.enum(Object.values(USER_ROLE) as [string, ...string[]], {
      message: 'Role is required.',
    }),
    token: z.string({
      message: 'token is required!',
    }),
    fcmToken: z.string().optional(),
    profileImage: z.string().optional(),
  }),
});

export const AuthValidation = {
  loginValidationSchema,
  loginWithPhoneValidationSchema,
  verifyEmailValidationSchema,
  forgotPasswordValidationSchema,
  resetPasswordValidationSchema,
  changePasswordValidationSchema,
  googleZodValidationSchema,
  appleZodValidationSchema,
};
