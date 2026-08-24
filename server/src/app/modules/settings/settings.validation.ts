import { z } from 'zod';
import { ALLOWED_KEYS, GENERAL_KEYS } from './settings.constant';

export type TGeneralKey = (typeof GENERAL_KEYS)[number];

// Create or Update Single Setting
export const createOrUpdateSettingZodSchema = z.object({
  params: z.object({
    key: z.enum(ALLOWED_KEYS as unknown as [string, ...string[]], {
      message: 'Invalid setting key provided',
    }),
  }),
  body: z.object({
    value: z.any(),
    name: z.string().trim().optional(),
  }),
});

// Update Multiple General Settings
export const updateGeneralsZodSchema = z.object({
  body: z
    .object({
      // Access & validation ride
      bookingMaxDaysAhead: z.number().optional(),
      splitRideMinBookingHours: z.number().optional(),
      splitRideRefundRestrictionHours: z.number().optional(),
      privateRideMinBookingHours: z.number().optional(),
      privateRideRefundRestrictionHours: z.number().optional(),
      matchingNoDriverNotifyHours: z.number().optional(),
      matchingLastNotifyHours: z.number().optional(),
      cancellationFreeWindowHours: z.number().optional(),
      cancellationPercentage50Hours: z.number().optional(),
      waitingReminderIntervals: z.number().optional(),

      // ride charge keys
      dayFareInitialCharge: z.number().optional(),
      dayFarePerKMRate: z.number().optional(),
      dayFareWaitingCharge: z.number().optional(),
      nightFareInitialCharge: z.number().optional(),
      nightFarePerKMRate: z.number().optional(),
      nightFareWaitingCharge: z.number().optional(),
      holidayIncreasePercentage: z.number().optional(),
      perLuggageCharge: z.number().optional(),
      fivePassengerExtraChargePercentage: z.number().optional(),
      sixPassengerExtraChargePercentage: z.number().optional(),
      baseFare: z.number().optional(),
      platformVat: z.number().optional(),
      platformCommissionPercent: z.number().optional(),
      // platform info
      supportContract: z.string().optional(),
      supportEmail: z.string().email({ message: 'Invalid email' }).optional(),

      // Trams and condition
      userTramsAndCondition: z.string().optional(),
      providerTramsAndCondition: z.string().optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: 'At least one general setting value must be provided',
    }),
});

export const SettingValidation = {
  createOrUpdateSettingZodSchema,
  updateGeneralsZodSchema,
};




