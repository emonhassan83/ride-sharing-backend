import { z } from 'zod';

const singleCarSchema = z.object({
  name: z.string().min(2, 'Vehicle name must be at least 2 characters'),
  number: z
    .string()
    .min(3, 'Vehicle number is required')
    .regex(/^[A-Za-z0-9- ]+$/, 'Invalid vehicle number format'),
  year: z
    .number()
    .min(1900, 'Year must be after 1900')
    .max(new Date().getFullYear() + 1, 'Invalid year'),
  seats: z
    .number()
    .min(1, 'At least 1 seat required')
    .max(20, 'Maximum 20 seats allowed'),
});

// Multiple cars schema
const createMultipleVehiclesZodSchema = z.object({
  body: z.array(singleCarSchema).min(1, 'At least one vehicle is required'),
});

// Create Vehicle Validation
const createVehicleZodSchema = z.object({
  body: singleCarSchema,
});

// Update Vehicle Validation
const updateVehicleZodSchema = z.object({
  body: z.object({
    name: z.string().min(2).optional(),
    number: z
      .string()
      .regex(/^[A-Za-z0-9- ]+$/)
      .optional(),
    year: z.number().min(1900).max(new Date().getFullYear() + 1).optional(),
    seats: z.number().min(1).max(20).optional()
  }),
});

export const VehicleValidation = {
  createMultipleVehiclesZodSchema,
  createVehicleZodSchema,
  updateVehicleZodSchema
};