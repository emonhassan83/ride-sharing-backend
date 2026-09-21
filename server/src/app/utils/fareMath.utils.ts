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

/** Day = 06:00:00–20:29:59, Night = 20:30:00–05:59:59 (second-level). */
const toDaySeconds = (
  hour: number,
  minute = 0,
  second = 0,
): number => hour * 3600 + minute * 60 + second;

export const isDayFareTime = (departureTime: string): boolean => {
  const [hourStr, minuteStr = '0', secondStr = '0'] = departureTime.split(':');
  const totalSeconds = toDaySeconds(
    Number(hourStr),
    Number(minuteStr),
    Number(secondStr),
  );
  // Day: >= 06:00:00 and < 20:30:00
  return totalSeconds >= 6 * 3600 && totalSeconds < 20 * 3600 + 30 * 60;
};

export const isDayFareDateTime = (dateTime: Date): boolean => {
  const totalSeconds =
    dateTime.getHours() * 3600 +
    dateTime.getMinutes() * 60 +
    dateTime.getSeconds();
  return totalSeconds >= 6 * 3600 && totalSeconds < 20 * 3600 + 30 * 60;
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
  /** PMCrfPR — baked into private & unmatched-split upfront fare. */
  platformCommissionPercent: number;
  /** PMCrfSR for matched split (2→30%, 3→50%). */
  splitRideMatchedSurchargePercent: number;
  /** Sum of each rider's initial upfront totals (after PMCrfPR + €5 + min). */
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

/** Resolve PMCrfSR by matched rider count (client: 2→+30%, 3→+50%). */
export const resolveSplitMatchedSurchargePercent = (
  riderCount: number,
  twoRiderPercent = 30,
  threeRiderPercent = 50,
): number => {
  const count = Math.max(Number(riderCount) || 1, 1);
  if (count >= 3) return threeRiderPercent;
  if (count >= 2) return twoRiderPercent;
  return 0;
};

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
  const riders = Math.max(Number(riderCount) || 1, 1);
  const isMatchedSplit = isSplit && riders >= 2;
  const actualFare = roundMoney(rawComponentFare);

  // PMCrfPR baked into private + unmatched-split initial upfront.
  const afterPmc = roundMoney(
    actualFare * (1 + Number(platformCommissionPercent || 0) / 100),
  );
  const initialBracket = roundUpToFiveBracket(afterPmc, fareRoundingBracket);
  const initialUpfront = Math.max(initialBracket, baseFare);

  let totalFare: number;
  let fareBeforeFees: number;
  let bracketRoundedFare: number;
  let minimumFareAdjustment: number;
  let minimumFareApplied: boolean;
  let splitRideMatchedSurchargeAmount = 0;
  const splitPercent = isMatchedSplit ? splitRideMatchedSurchargePercent : 0;

  if (isMatchedSplit) {
    // Worked example: avg(initial upfronts) × PMCrfSR ÷ riders → €5 ceil → min.
    const poolInitial = roundMoney(
      poolKomistraBase ?? initialUpfront * riders,
    );
    const averageInitial = roundMoney(poolInitial / riders);
    const sharedBasis = roundMoney(
      averageInitial * (1 + splitRideMatchedSurchargePercent / 100),
    );
    splitRideMatchedSurchargeAmount = roundMoney(sharedBasis - averageInitial);
    const perRiderBeforeBracket = roundMoney(sharedBasis / riders);
    bracketRoundedFare = roundUpToFiveBracket(
      perRiderBeforeBracket,
      fareRoundingBracket,
    );
    totalFare = Math.max(bracketRoundedFare, baseFare);
    fareBeforeFees = averageInitial;
    minimumFareApplied = totalFare > bracketRoundedFare;
    minimumFareAdjustment = roundMoney(totalFare - bracketRoundedFare);
  } else {
    bracketRoundedFare = initialBracket;
    totalFare = initialUpfront;
    fareBeforeFees = afterPmc;
    minimumFareApplied = totalFare > bracketRoundedFare;
    minimumFareAdjustment = roundMoney(totalFare - bracketRoundedFare);
  }

  // VAT extracted from regulated base (display); PMC baked into totalFare only.
  const vatAmount = extractIncludedVat(totalFare, platformVatPercent);
  const netBeforeVat = roundMoney(totalFare - vatAmount);

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
      ? roundMoney(splitRideMatchedSurchargeAmount / riders)
      : 0,
    // Not rider-facing; keep 0 so APIs don't show a separate platform charge.
    platformCommissionPercent: 0,
    platformCommissionAmount: 0,
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

  if (rideType === 'private' || rideType === 'split') {
    // Reverse baked PMCrfPR from passenger total (lossy around €5 brackets).
    return roundMoney(total / (1 + platformCommissionPercent / 100));
  }

  return total;
};
