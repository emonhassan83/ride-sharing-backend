import { z } from 'zod';
import { PROVIDER_STATUS } from './provider.constant';
import { PROVIDER_TYPE } from '../user/user.constant';

const imageUrlSchema = z
  .string({ message: 'Image URL is required' })
  .url({ message: 'Must be a valid image URL' })
  .trim();

// ─────────────────────────────────────────────────────────────
// Create Provider (Initial Submission)
// ─────────────────────────────────────────────────────────────
const createProviderZodSchema = z.object({
  body: z.object({
    type: z.enum(Object.values(PROVIDER_TYPE) as [string, ...string[]], {
      message: 'Provider type must be either self-employed or company',
    }),

    companyName: z
      .string()
      .min(3, { message: 'Company name must be at least 3 characters long' })
      .max(100, { message: 'Company name is too long' })
      .trim(),

    companyReg: z
      .string()
      .min(3, { message: 'Company registration number is required' })
      .trim(),

    vatNumber: z
      .string()
      .min(3, { message: 'VAT number is required' })
      .trim(),

    ibanNumber: z
      .string()
      .min(3, { message: 'IBAN number is required' })
      .trim(),

    cnicFront: imageUrlSchema,
    cnicBack: imageUrlSchema,
    licenseFront: imageUrlSchema,
    licenseBack: imageUrlSchema,

    carPapers: z
      .array(imageUrlSchema, { message: 'Car papers are required' })
      .min(1, { message: 'At least 1 car paper is required' })
      .max(10, { message: 'Maximum 10 car papers allowed' }),
  }),
});

// ─────────────────────────────────────────────────────────────
// Update Documents (After Rejection)
// ─────────────────────────────────────────────────────────────
const updateProviderZodSchema = z.object({
  body: z.object({
    companyName: z
      .string()
      .min(3)
      .max(100)
      .trim()
      .optional(),

    type: z.enum(Object.values(PROVIDER_TYPE) as [string, ...string[]]).optional(),
    companyReg: z.string().trim().optional(),
    vatNumber: z.string().trim().optional(),
    ibanNumber: z.string().trim().optional(),

    cnicFront: imageUrlSchema.optional(),
    cnicBack: imageUrlSchema.optional(),
    licenseFront: imageUrlSchema.optional(),
    licenseBack: imageUrlSchema.optional(),

    carPapers: z
      .array(imageUrlSchema)
      .min(1, { message: 'At least 1 car paper is required' })
      .max(10, { message: 'Maximum 10 car papers allowed' })
      .optional(),
  })
    .refine((data) => Object.keys(data).length > 0, {
      message: 'At least one field must be provided for update',
    }),
});

// ─────────────────────────────────────────────────────────────
// Update Status (Admin Only)
// ─────────────────────────────────────────────────────────────
const updateStatusZodSchema = z.object({
  body: z.object({
    status: z.enum(Object.values(PROVIDER_STATUS) as [string, ...string[]]),

    rejectionReason: z
      .string()
      .trim()
      .min(10, { message: 'Rejection reason must be at least 10 characters' })
      .max(1000, { message: 'Rejection reason is too long' })
      .optional(),
  })
    .refine(
      (data) =>
        !(data.status === PROVIDER_STATUS.rejected && !data.rejectionReason),
      {
        message: 'Rejection reason is required when rejecting a provider',
        path: ['rejectionReason'],
      }
    )
    .refine(
      (data) =>
        !(data.status !== PROVIDER_STATUS.rejected && data.rejectionReason),
      {
        message: 'Rejection reason should only be provided when status is rejected',
        path: ['rejectionReason'],
      }
    ),
});

export const ProviderValidation = {
  createProviderZodSchema,
  updateProviderZodSchema,
  updateStatusZodSchema
};

