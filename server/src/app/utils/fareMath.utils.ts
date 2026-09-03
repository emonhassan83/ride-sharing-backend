export const roundMoney = (value: number): number =>
  Math.round(Number(value || 0) * 100) / 100;

/** Round up to the next EUR 5 (or configurable) bracket. */
export const roundUpToFiveBracket = (
  amount: number,
  bracket = 5,
): number => {
  if (amount <= 0) return 0;
  return Math.ceil(amount / bracket) * bracket;
};

/** Komistra amounts include VAT; extract for display only. */
export const extractIncludedVat = (
  gross: number,
  vatPercent = 9,
): number => {
  if (vatPercent <= 0 || gross <= 0) return 0;
  return roundMoney((gross * vatPercent) / (100 + vatPercent));
};

export const applyMinimumFare = (
  actualFare: number,
  baseFare: number,
): {
  fareBeforeFees: number;
  minimumFareAdjustment: number;
  minimumFareApplied: boolean;
} => {
  const fareBeforeFees = roundMoney(Math.max(actualFare, baseFare));
  const minimumFareAdjustment = roundMoney(fareBeforeFees - actualFare);
  return {
    fareBeforeFees,
    minimumFareAdjustment,
    minimumFareApplied: minimumFareAdjustment > 0,
  };
};

/** Day = 06:00-20:29, Night = 20:30-05:59 (official Cyprus tariff). */
export const isDayFareTime = (departureTime: string): boolean => {
  const [hourStr, minuteStr = '0'] = departureTime.split(':');
  const totalMinutes = Number(hourStr) * 60 + Number(minuteStr);
  return totalMinutes >= 360 && totalMinutes < 1230;
};

export const isDayFareDateTime = (dateTime: Date): boolean => {
  const totalMinutes = dateTime.getHours() * 60 + dateTime.getMinutes();
  return totalMinutes >= 360 && totalMinutes < 1230;
};

export interface DayNightRateSettings {
  dayFareInitialCharge: number;
  dayFarePerKMRate: number;
  dayFareWaitingCharge: number;
  nightFareInitialCharge: number;
  nightFarePerKMRate: number;
  nightFareWaitingCharge: number;
}

export interface DayNightRates {
  initialCharge: number;
  perKm: number;
  waitingChargePerHour: number;
}

export const getDayNightRates = (
  departureTime: string,
  settings: DayNightRateSettings,
): DayNightRates => {
  const isDay = isDayFareTime(departureTime);
  return isDay
    ? {
        initialCharge: settings.dayFareInitialCharge,
        perKm: settings.dayFarePerKMRate,
        waitingChargePerHour: settings.dayFareWaitingCharge,
      }
    : {
        initialCharge: settings.nightFareInitialCharge,
        perKm: settings.nightFarePerKMRate,
        waitingChargePerHour: settings.nightFareWaitingCharge,
      };
};

export interface PassengerFareTotalsInput {
  rideType: 'private' | 'split';
  riderCount: number;
  rawComponentFare: number;
  baseFare: number;
  platformVatPercent: number;
  platformCommissionPercent: number;
  splitRideMatchedSurchargePercent: number;
  /** Sum of all matched riders' komistra bases (split matched pool). */
  poolKomistraBase?: number;
  fareRoundingBracket?: number;
}

export interface PassengerFareTotals {
  actualFare: number;
  fareBeforeFees: number;
  bracketRoundedFare: number;
  minimumFareAdjustment: number;
  minimumFareApplied: boolean;
  splitRideMatchedSurchargePercent: number;
  splitRideMatchedSurchargeAmount: number;
  splitSurchargePercent: number;
  splitSurchargeAmount: number;
  platformCommissionPercent: number;
  platformCommissionAmount: number;
  platformVatPercent: number;
  vatAmount: number;
  vatIncluded: boolean;
  netBeforeVat: number;
  fareBeforePlatformCommission: number;
  totalFare: number;
}

export const buildPassengerFareTotals = (
  input: PassengerFareTotalsInput,
): PassengerFareTotals => {
  const {
    rideType,
    riderCount,
    rawComponentFare,
    baseFare,
    platformVatPercent,
    platformCommissionPercent,
    splitRideMatchedSurchargePercent,
    poolKomistraBase,
    fareRoundingBracket = 5,
  } = input;

  const isSplit = rideType === 'split';
  const isMatchedSplit = isSplit && Math.max(riderCount, 1) >= 2;
  const splitPercent = isSplit ? splitRideMatchedSurchargePercent : 0;
  const actualFare = roundMoney(rawComponentFare);

  let totalFare: number;
  let fareBeforeFees: number;
  let bracketRoundedFare: number;
  let minimumFareAdjustment: number;
  let minimumFareApplied: boolean;
  const platformCommissionAmount = 0;
  let splitRideMatchedSurchargeAmount = 0;

  if (isMatchedSplit) {
    const poolBase = roundMoney(
      poolKomistraBase ?? rawComponentFare * Math.max(riderCount, 1),
    );
    const poolWithSurcharge = roundMoney(
      poolBase * (1 + splitRideMatchedSurchargePercent / 100),
    );
    splitRideMatchedSurchargeAmount = roundMoney(poolWithSurcharge - poolBase);
    const perRiderBeforeBracket = roundMoney(poolWithSurcharge / riderCount);
    bracketRoundedFare = roundUpToFiveBracket(
      perRiderBeforeBracket,
      fareRoundingBracket,
    );
    totalFare = Math.max(bracketRoundedFare, baseFare);
    fareBeforeFees = roundMoney(poolBase / riderCount);
    minimumFareApplied = totalFare > bracketRoundedFare;
    minimumFareAdjustment = roundMoney(totalFare - bracketRoundedFare);
  } else if (isSplit) {
    bracketRoundedFare = roundUpToFiveBracket(
      rawComponentFare,
      fareRoundingBracket,
    );
    totalFare = Math.max(bracketRoundedFare, baseFare);
    fareBeforeFees = totalFare;
    minimumFareApplied = totalFare > bracketRoundedFare;
    minimumFareAdjustment = roundMoney(totalFare - bracketRoundedFare);
  } else {
    bracketRoundedFare = roundUpToFiveBracket(
      rawComponentFare,
      fareRoundingBracket,
    );
    totalFare = Math.max(bracketRoundedFare, baseFare);
    fareBeforeFees = actualFare;
    minimumFareApplied = totalFare > bracketRoundedFare;
    minimumFareAdjustment = roundMoney(totalFare - bracketRoundedFare);
  }

  const vatAmount = extractIncludedVat(actualFare, platformVatPercent);
  const netBeforeVat = roundMoney(actualFare - vatAmount);

  return {
    actualFare,
    fareBeforeFees,
    bracketRoundedFare,
    minimumFareAdjustment,
    minimumFareApplied,
    splitRideMatchedSurchargePercent: splitPercent,
    splitRideMatchedSurchargeAmount,
    splitSurchargePercent: splitPercent,
    splitSurchargeAmount: isMatchedSplit
      ? roundMoney(splitRideMatchedSurchargeAmount / riderCount)
      : splitRideMatchedSurchargeAmount,
    platformCommissionPercent: 0,
    platformCommissionAmount,
    platformVatPercent,
    vatAmount,
    vatIncluded: true,
    netBeforeVat,
    fareBeforePlatformCommission: actualFare,
    totalFare,
  };
};

export interface DriverPayoutBreakdown {
  driverGrossAmount: number;
  driverPlatformFeeAmount: number;
  driverVatAmount: number;
  driverEarningAmount: number;
  driverPlatformFeePercent: number;
  driverVatPercent: number;
}

export interface DriverPayoutSettings {
  driverPlatformFeePercent: number;
  driverVatPercent: number;
  platformCommissionPercent: number;
  splitRideMatchedSurchargePercent: number;
}

export const computeDriverPayoutFromPassengerTotal = (
  totalFare: number,
  rideType: 'private' | 'split',
  settings: DriverPayoutSettings,
  isMatchedSplit = false,
): DriverPayoutBreakdown & { komistraGross: number } => {
  const komistraGross = reversePassengerTotalToBase({
    totalFare,
    rideType,
    riderCount: isMatchedSplit ? 2 : 1,
    platformCommissionPercent: settings.platformCommissionPercent,
    splitRideMatchedSurchargePercent: settings.splitRideMatchedSurchargePercent,
  });

  const payout = buildDriverPayout(
    komistraGross,
    settings.driverPlatformFeePercent,
    settings.driverVatPercent,
  );

  return { ...payout, komistraGross };
};

export const buildDriverPayout = (
  gross: number,
  feePercent = 15,
  vatPercent = 19,
): DriverPayoutBreakdown => {
  const driverGrossAmount = roundMoney(Math.max(gross, 0));
  const driverPlatformFeeAmount = roundMoney(
    driverGrossAmount * (feePercent / 100),
  );
  const netAfterPlatformFee = roundMoney(
    driverGrossAmount - driverPlatformFeeAmount,
  );
  const driverVatAmount = roundMoney(netAfterPlatformFee * (vatPercent / 100));
  const driverEarningAmount = roundMoney(netAfterPlatformFee - driverVatAmount);

  return {
    driverGrossAmount,
    driverPlatformFeeAmount,
    driverVatAmount,
    driverEarningAmount,
    driverPlatformFeePercent: feePercent,
    driverVatPercent: vatPercent,
  };
};

/** Reverse passenger total to komistra base (fareBeforeFees). */
export const reversePassengerTotalToBase = (params: {
  totalFare: number;
  rideType: 'private' | 'split';
  riderCount: number;
  platformCommissionPercent: number;
  splitRideMatchedSurchargePercent: number;
}): number => {
  const {
    totalFare,
    rideType,
    riderCount,
    platformCommissionPercent,
    splitRideMatchedSurchargePercent,
  } = params;
  const total = roundMoney(totalFare);
  if (total <= 0) return 0;

  const isMatchedSplit = rideType === 'split' && Math.max(riderCount, 1) >= 2;

  if (isMatchedSplit) {
    return roundMoney(total / (1 + splitRideMatchedSurchargePercent / 100));
  }
  return total;
};
