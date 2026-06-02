import { z } from 'zod';
import { FARE_TYPE, CANCELLED_BY } from './passenger.constant';

const coordinatesSchema = z.tuple([z.number(), z.number()]);

export const createZodSchema = z.object({
  body: z.object({
    rideId: z.string().min(1, 'Driver ID is required'),
    
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
    
    requestedSeats: z.number().min(1),

    fareType: z.enum(Object.values(FARE_TYPE) as [string, ...string[]]),
    luggageCounts: z.number().min(0).default(0),
    note: z.string().optional()
  }),
});


export const PassengerValidation = {
  createZodSchema
};