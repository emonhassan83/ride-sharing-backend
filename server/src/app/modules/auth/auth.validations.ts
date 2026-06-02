import { z } from 'zod';
import { USER_ROLE } from '../user/user.constant';

const loginValidationSchema = z.object({
  body: z.object({
    email: z
      .string({
        required_error: 'Email is required.',
        invalid_type_error: 'Email must be a string.',
      })
      .email('Invalid email address.'),
    password: z
      .string({
        required_error: 'Password is required.',
        invalid_type_error: 'Password must be a string.',
      })
      .min(8, 'Password must be at least 8 characters long.'),
  }),
});

const loginWithPhoneValidationSchema = z.object({
  body: z.object({
    phone: z
      .string({ required_error: 'Phone number is required!' })
      .min(6, { message: 'Contact number must be at least 6 digits long' })
      .max(15, { message: 'Contact number must be at most 15 digits long' }),
    countryCode: z
      .string({ required_error: 'Country code is required!' })
      .min(1, 'Country code cannot be empty.'),
  }),
});

const verifyEmailValidationSchema = z.object({
  body: z.object({
    otp: z
      .string({
        required_error: 'One time code is required.',
        invalid_type_error: 'One time code must be a string.',
      })
      .min(6, 'One time code must be at least 6 characters long.'),
    email: z
      .string({
        required_error: 'Email is required.',
        invalid_type_error: 'Email must be a string.',
      })
      .email('Invalid email address.'),
    token: z.string({
      required_error: 'Token is required.',
      invalid_type_error: 'Token must be a string.',
    }),
  }),
});

const forgotPasswordValidationSchema = z.object({
  body: z.object({
    email: z
      .string({
        required_error: 'Email is required.',
        invalid_type_error: 'Email must be a string.',
      })
      .email('Invalid email address.'),
  }),
});

const resetPasswordValidationSchema = z.object({
  body: z.object({
    password: z
      .string({
        required_error: 'Password is required.',
        invalid_type_error: 'Password must be a string.',
      })
      .min(8, 'Password must be at least 8 characters long.'),
    confirmPassword: z
      .string({
        required_error: 'Confirm Password is required.',
        invalid_type_error: 'Confirm Password must be a string.',
      })
      .min(8, 'Password must be at least 8 characters long.'),
  }),
});

const changePasswordValidationSchema = z.object({
  body: z.object({
    currentPassword: z
      .string({
        required_error: 'Old password is required.',
        invalid_type_error: 'Old password must be a string.',
      })
      .min(8, 'Old password must be at least 8 characters long.'),
    password: z
      .string({
        required_error: 'New password is required.',
        invalid_type_error: 'New password must be a string.',
      })
      .min(8, 'New password must be at least 8 characters long.'),
    confirmPassword: z
      .string({
        required_error: 'New password is required.',
        invalid_type_error: 'New password must be a string.',
      })
      .min(8, 'New password must be at least 8 characters long.'),
  }),
});

const googleZodValidationSchema = z.object({
  body: z.object({
    name: z
      .string({
        required_error: 'Name is required.',
        invalid_type_error: 'Name must be a string.',
      })
      .min(1, 'Name cannot be empty.'),
    email: z
      .string({
        required_error: 'Email is required.',
        invalid_type_error: 'Email must be a string.',
      })
      .email('Invalid email address.'),
    role: z.enum(Object.values(USER_ROLE) as [string, ...string[]], {
      invalid_type_error: 'Role must be a valid option.',
      required_error: 'Role is required.',
    }),
    token: z.string({
      required_error: 'token is required!',
    }),
    fcmToken: z.string().optional(),
    profileImage: z.string().optional(),
  }),
});

const appleZodValidationSchema = z.object({
  body: z.object({
    name: z
      .string({
        required_error: 'Name is required.',
        invalid_type_error: 'Name must be a string.',
      })
      .min(1, 'Name cannot be empty.'),
    email: z
      .string({
        required_error: 'Email is required.',
        invalid_type_error: 'Email must be a string.',
      })
      .email('Invalid email address.'),
    role: z.enum(Object.values(USER_ROLE) as [string, ...string[]], {
      invalid_type_error: 'Role must be a valid option.',
      required_error: 'Role is required.',
    }),
    token: z.string({
      required_error: 'token is required!',
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
