export const GENERAL_KEYS = [
  'bookingMaxDaysAhead',
  "splitRideMinBookingHours",
  "splitRideRefundRestrictionHours",
  "privateRideMinBookingHours",
  "privateRideRefundRestrictionHours",
  "matchingNoDriverNotifyHours",
  "matchingLastNotifyHours",
  "cancellationFreeWindowHours",
  "cancellationPercentage50Hours",
  "waitingReminderIntervals",
  "waitingTimeMinutes",

  // ride charge keys
  'dayFareInitialCharge',
  'dayFarePerKMRate',
  'dayFareWaitingCharge',
  'nightFareInitialCharge',
  'nightFarePerKMRate',
  'nightFareWaitingCharge',
  'holidayIncreasePercentage',
  'perLuggageCharge',
  'fivePassengerExtraCharge',
  'sixPassengerExtraChargePercentage',
  'platformCommissionPercent',

  // platform info
  'supportContract',
  'supportEmail',
] as const;

export const ALLOWED_KEYS = [
  ...GENERAL_KEYS,
  'userTramsAndCondition',
  'providerTramsAndCondition',
] as const;



