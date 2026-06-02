import { z } from 'zod';
import { USER_ROLE, USER_STATUS } from './user.constant';

const createUserValidationSchema = z.object({
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

      countryCode: z
  .string()
  .min(1, 'Country code cannot be empty.'),

      phone: z
  .string({ required_error: 'Phone number is required!' })
  .min(6, { message: 'Contact number must be at least 6 digits long' })
  .max(15, { message: 'Contact number must be at most 15 digits long' }),

      role: z.enum(Object.values(USER_ROLE) as [string, ...string[]], {
  invalid_type_error: 'Role must be a valid option.',
  required_error: 'Role is required.',
}),
    })
    .strict(),
});

const updateUserValidationSchema = z.object({
  body: z.object({
    name: z.string().optional(),
    phone: z.string().optional(),
    countryCode: z.string().optional(),
    address: z.string().optional(),
    dateOfBirth: z.string().optional(),
    profileImage: z.string().optional(),
    gender: z.string().optional(),
    language: z.string().optional(),
  }),
});

const changeStatusValidationSchema = z.object({
  body: z.object({
    status: z.enum(Object.values(USER_STATUS) as [string, ...string[]], {
      required_error: 'User status is required!',
    }),
  }),
});

const updateLocationValidationSchema = z.object({
  body: z.object({
    longitude: z.number({
      required_error: 'longitude is required!',
    }),
    latitude: z.number({
      required_error: 'latitude is required!',
    }),
    address: z.string().min(1, 'Address cannot be empty.'),
  }),
});

const profileDeletionValidationSchema = z.object({
  body: z.object({
    reason: z.string().min(1, 'Profile deletion reason cannot be empty.'),
  }),
});

const changeEmailZodSchema = z.object({
  body: z.object({
    email: z.string().email('Please provide a valid email address'),
  }),
});

export const UserValidation = {
  createUserValidationSchema,
  updateUserValidationSchema,
  changeStatusValidationSchema,
  updateLocationValidationSchema,
  profileDeletionValidationSchema,
  changeEmailZodSchema,
};
