import { z } from 'zod';

const coordinatesSchema = z.tuple([z.number(), z.number()]);

// Create Saved Place
export const createSavedPlacesZodSchema = z.object({
  body: z.object({
    label: z.string().min(2).max(100),
    streetName: z.string().min(2).max(100),
    streetNumber: z.string().min(1).max(50),
    district: z.string().min(2).max(100),
    municipality: z.string().min(2).max(100),
    zip: z.number().int().positive(),
    location: z.object({
      type: z.literal('Point'),
      coordinates: coordinatesSchema,
    }),
    isPinned: z.boolean().optional().default(false),
  }),
});

// Update Saved Place
export const updateSavedPlacesZodSchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Location ID is required'),
  }),
  body: z.object({
    label: z.string().min(2).max(100).optional(),
    streetName: z.string().min(2).max(100).optional(),
    streetNumber: z.string().min(1).max(50).optional(),
    district: z.string().min(2).max(100).optional(),
    municipality: z.string().min(2).max(100).optional(),
    zip: z.number().int().positive().optional(),
    location: z
      .object({
        type: z.literal('Point'),
        coordinates: coordinatesSchema,
      })
      .optional(),
    isPinned: z.boolean().optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  }),
});

export const SavedPlacesValidation = {
  createSavedPlacesZodSchema,
  updateSavedPlacesZodSchema
};