import { z } from 'zod';
import { RIDE_TYPE } from './ride.constant';

const coordinatesSchema = z.tuple([z.number(), z.number()]);

export const createRideZodSchema = z.object({
  body: z.object({
    driverId: z.string().min(1, 'Driver ID is required'),
    rideType: z.enum(Object.values(RIDE_TYPE) as [string, ...string[]]),
    
    pickup: z.object({
      address: z.string().min(5, 'Pickup address is too short'),
      coordinates: coordinatesSchema,
    }),
    
    destination: z.object({
      address: z.string().min(5, 'Destination address is too short'),
      coordinates: coordinatesSchema,
    }),

    departureDate: z.string().datetime({ message: 'Invalid departure time' }),
    departureTime: z.string().datetime({ message: 'Invalid departure time' }),
  }),
});

export const RideValidation = {
  createRideZodSchema
};