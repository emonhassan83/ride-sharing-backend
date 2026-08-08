export const GENERAL_KEYS = [
  'bookingMaxDaysAhead',
  "bookingMinDaysAhead",
  "matchingNoDriverNotifyHours",
  "matchingLastNotifyHours",
  "matchingDriverResponseMinutes",
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
