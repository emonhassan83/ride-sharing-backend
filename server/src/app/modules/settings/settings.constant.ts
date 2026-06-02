export const GENERAL_KEYS = [
  'dayFareInitialCharge',
  'dayFarePerKMRate',
  'dayFareWaitingCharge',
  'nightFareInitialCharge',
  'nightFarePerKMRate',
  'nightFareWaitingCharge',
  'publicHolidayIncrease',
  'perLuggageCharge',
  'fourPassengerTaxiTax',
  'sixPassengerTaxiTaxPercentage',
  'platformVat',
  'supportContract',
  'supportEmail',
] as const;

export const ALLOWED_KEYS = [
  ...GENERAL_KEYS,
  'userTramsAndCondition',
  'providerTramsAndCondition',
] as const;
