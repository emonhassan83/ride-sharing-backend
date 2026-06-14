export const GENERAL_KEYS = [
  'bookingMaxDaysAhead',
  "bookingMinDaysAhead",
  "matchingNoDriverNotifyHours",
  "matchingLastNotifyHours",
  "cancellationFreeWindowHours",
  "cancellationPercentage50Hours",
  "waitingReminderIntervals",

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
  "platformCommissionPercent",

  // platform info
  'supportContract',
  'supportEmail',
] as const;

export const ALLOWED_KEYS = [
  ...GENERAL_KEYS,
  'userTramsAndCondition',
  'providerTramsAndCondition',
] as const;
