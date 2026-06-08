export const GENERAL_KEYS = [
  'bookingMaxDaysAhead',
  "bookingMinDaysAhead",
  "matchingNoDriverNotifyHours",
  "matchingLastNotifyHours",
  "cancellationFreeWindowHours",
  "cancellationPercentage50Hours",
  "waitingTimeMinutes",
  "waitingReminderIntervals",
  "pendingRideCancelHours",
  "pendingRideNotifyHours",
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
  'platformVat',
  // platform commission
  "platformCommissionPercent",
  'supportContract',
  'supportEmail',
] as const;

export const ALLOWED_KEYS = [
  ...GENERAL_KEYS,
  'userTramsAndCondition',
  'providerTramsAndCondition',
] as const;
