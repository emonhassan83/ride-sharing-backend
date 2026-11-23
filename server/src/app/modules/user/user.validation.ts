import { z } from 'zod';
import { PROVIDER_TYPE, USER_ROLE, USER_STATUS } from './user.constant';
import {
  INVALID_ADDRESS_MESSAGE,
  INVALID_DOB_MESSAGE,
  INVALID_NAME_MESSAGE,
  isValidAddress,
  isValidDateOfBirth,
  isValidPersonName,
} from '../../utils/profileValidation.utils';

// Issues 24, 27, 29: "." was accepted as a name/address, and 1900 as a birth year.
const nameField = z.string().trim().refine(isValidPersonName, { message: INVALID_NAME_MESSAGE });
const addressField = z.string().trim().refine(isValidAddress, { message: INVALID_ADDRESS_MESSAGE });
const dateOfBirthField = z.string().trim().refine((v) => isValidDateOfBirth(v), { message: INVALID_DOB_MESSAGE });

const createUserValidationSchema = z.object({
  body: z
    .object({
      name: z
        .string({
          message: 'Name is required.',
        })
        .min(1, { message: 'Name cannot be empty.' })
        .pipe(nameField),

      email: z
        .string({
          message: 'Email is required.',
        })
        .email({ message: 'Invalid email address.' }),

      countryCode: z
        .string()
        .min(1, { message: 'Country code cannot be empty.' })
        .optional(),

      phone: z
        .string({ message: 'Phone number is required!' })
        .min(6, { message: 'Contact number must be at least 6 digits long' })
        .max(15, { message: 'Contact number must be at most 15 digits long' }),

      role: z
        .enum(Object.values(USER_ROLE) as [string, ...string[]], {
          message: 'Role must be user or provider.',
        })
        .optional(),

      fcmToken: z.string().optional(),
    })
    .passthrough(),
});

const updateUserValidationSchema = z.object({
  body: z.object({
    role: z.enum([USER_ROLE.user, USER_ROLE.provider] as [string, ...string[]]).optional(),
    type: z.enum(Object.values(PROVIDER_TYPE) as [string, ...string[]]).optional(),
    name: nameField.optional(),
    phone: z.string().optional(),
    countryCode: z.string().optional(),
    address: addressField.optional(),
    dateOfBirth: dateOfBirthField.optional(),
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
    address: z.string().min(1, { message: 'Address cannot be empty.' }).pipe(addressField),
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


