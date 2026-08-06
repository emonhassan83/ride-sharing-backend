import { z } from 'zod';
import { PROVIDER_TYPE, USER_ROLE, USER_STATUS } from './user.constant';

const createUserValidationSchema = z.object({
  body: z
    .object({
      name: z
        .string({
          message: 'Name is required.',
        })
        .min(1, { message: 'Name cannot be empty.' }),

      email: z
        .string({
          message: 'Email is required.',
        })
        .email({ message: 'Invalid email address.' }),

      countryCode: z
        .string()
        .min(1, { message: 'Country code cannot be empty.' }),

      phone: z
        .string({ message: 'Phone number is required!' })
        .min(6, { message: 'Contact number must be at least 6 digits long' })
        .max(15, { message: 'Contact number must be at most 15 digits long' }),

      role: z.enum(Object.values(USER_ROLE) as [string, ...string[]], {
        message: 'Role is required.',
      }),

      type: z.enum(Object.values(PROVIDER_TYPE) as [string, ...string[]], {
        message: 'Provider type must be either self-employed or company',
      }).optional(),

      fcmToken: z.string().optional(),
    })
    .strict()
    .refine((data) => data.role !== USER_ROLE.provider || !!data.type, {
      message: 'Provider type is required for provider registration.',
      path: ['type'],
    }),
});

const updateUserValidationSchema = z.object({
  body: z.object({
    type: z.enum(Object.values(PROVIDER_TYPE) as [string, ...string[]]).optional(),
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
      message: 'User status is required!',
    }),
  }),
});

const updateLocationValidationSchema = z.object({
  body: z.object({
    longitude: z.number({
      message: 'longitude is required!',
    }),
    latitude: z.number({
      message: 'latitude is required!',
    }),
    address: z.string().min(1, { message: 'Address cannot be empty.' }),
  }),
});

const profileDeletionValidationSchema = z.object({
  body: z.object({
    reason: z
      .string()
      .min(1, { message: 'Profile deletion reason cannot be empty.' }),
  }),
});

const changeEmailZodSchema = z.object({
  body: z.object({
    email: z
      .string()
      .email({ message: 'Please provide a valid email address' }),
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

