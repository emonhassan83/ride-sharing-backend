export const DEFAULT_GENERAL_SETTINGS = {
  bookingMaxDaysAhead: 30,
  splitRideMinBookingHours: 3,
  splitRideMinDistanceKm: 20,
  splitRidePickupMatchRadiusKm: 10,
  splitRideDestinationMatchRadiusKm: 10,
  /** 0 = exact same departureTime until PO sets a real window */
  splitRideMatchingTimeWindowMinutes: 0,
  splitRideRefundRestrictionHours: 24,
  privateRideMinBookingHours: 1,
  privateRideRefundRestrictionHours: 1,
  matchingNoDriverNotifyHours: 48,
  matchingLastNotifyHours: 1,
  cancellationFreeWindowHours: 24,
  cancellationPercentage50Hours: 3,
  waitingReminderIntervals: 10,
  waitingTimeMinutes: 60,

  dayFareInitialCharge: 3.8,
  dayFarePerKMRate: 0.95,
  dayFareWaitingCharge: 17,
  nightFareInitialCharge: 4.8,
  nightFarePerKMRate: 1.1,
  nightFareWaitingCharge: 19,
  holidayIncreasePercentage: 20,
  perLuggageCharge: 1.4,
  fivePassengerExtraChargePercentage: 20,
  sixPassengerExtraChargePercentage: 40,
  baseFare: 20,
  splitRideMatchedSurchargePercent: 30,
  splitRideMatchedSurchargePercent3: 50,
  splitRideMaxMatchedRiders: 3,
  platformVat: 9,
  platformCommissionPercent: 10,
  driverPlatformFeePercent: 15,
  driverVatPercent: 19,
  fareRoundingBracket: 5,

  supportEmail: 'support@yourapp.com',
} as const;

export const PLATFORM_SELLER_KEY = 'platformSeller';

/** Split Ride Ltd seller + payout bank details (admin-editable). */
export const DEFAULT_PLATFORM_SELLER = {
  companyName: 'Split Ride Ltd',
  addressLine1: 'Stasikratous 37, 4th Floor',
  addressLine2: '1065 Nicosia, Cyprus',
  regCode: 'HE412953',
  vatNumber: 'CY10412953X',
  accountHolderName: 'SPLIT RIDE LTD',
  bankName: 'BANK OF CYPRUS',
  iban: 'CY39002001950000357012345678',
  swiftBic: 'BCYPCY21XXX',
} as const;

export type TPlatformSeller = {
  companyName: string;
  addressLine1: string;
  addressLine2: string;
  regCode: string;
  vatNumber: string;
  accountHolderName: string;
  bankName: string;
  iban: string;
  swiftBic: string;
};

export const GENERAL_KEYS = [
  'bookingMaxDaysAhead',
  'splitRideMinBookingHours',
  'splitRideMinDistanceKm',
  'splitRidePickupMatchRadiusKm',
  'splitRideDestinationMatchRadiusKm',
  'splitRideMatchingTimeWindowMinutes',
  'splitRideRefundRestrictionHours',
  'privateRideMinBookingHours',
  'privateRideRefundRestrictionHours',
  'matchingNoDriverNotifyHours',
  'matchingLastNotifyHours',
  'cancellationFreeWindowHours',
  'cancellationPercentage50Hours',
  'waitingReminderIntervals',
  'waitingTimeMinutes',
  'dayFareInitialCharge',
  'dayFarePerKMRate',
  'dayFareWaitingCharge',
  'nightFareInitialCharge',
  'nightFarePerKMRate',
  'nightFareWaitingCharge',
  'holidayIncreasePercentage',
  'perLuggageCharge',
  'fivePassengerExtraChargePercentage',
  'sixPassengerExtraChargePercentage',
  'baseFare',
  'splitRideMatchedSurchargePercent',
  'splitRideMatchedSurchargePercent3',
  'splitRideMaxMatchedRiders',
  'platformVat',
  'platformCommissionPercent',
  'driverPlatformFeePercent',
  'driverVatPercent',
  'fareRoundingBracket',
  'supportEmail',
] as const;

export const ALLOWED_KEYS = [
  ...GENERAL_KEYS,
  'userTramsAndCondition',
  'providerTramsAndCondition',
] as const;

