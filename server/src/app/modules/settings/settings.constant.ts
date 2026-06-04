export const GENERAL_KEYS = [
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
  'supportContract',
  'supportEmail',
] as const;

export const ALLOWED_KEYS = [
  ...GENERAL_KEYS,
  'userTramsAndCondition',
  'providerTramsAndCondition',
] as const;
