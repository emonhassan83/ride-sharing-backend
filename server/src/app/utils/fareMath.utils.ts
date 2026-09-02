export const roundMoney = (value: number): number =>
  Math.round(Number(value || 0) * 100) / 100;

/** Komistra amounts include VAT — extract for display only. */
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

/** Day = 05:00–22:29, Night = 22:30–04:59 (Komistra PDF). */
export const isDayFareTime = (departureTime: string): boolean => {
  const [hourStr, minuteStr = '0'] = departureTime.split(':');
  const totalMinutes = Number(hourStr) * 60 + Number(minuteStr);
  return totalMinutes >= 300 && totalMinutes < 1350;
};

export const isDayFareDateTime = (dateTime: Date): boolean => {
  const totalMinutes = dateTime.getHours() * 60 + dateTime.getMinutes();
  return totalMinutes >= 300 && totalMinutes < 1350;
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
}

export interface PassengerFareTotals {
  actualFare: number;
  fareBeforeFees: number;
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
  } = input;

  const isSplit = rideType === 'split';
  const isMatchedSplit = isSplit && Math.max(riderCount, 1) >= 2;
  const { fareBeforeFees, minimumFareAdjustment, minimumFareApplied } =
    applyMinimumFare(rawComponentFare, baseFare);

  const splitPercent = isSplit ? splitRideMatchedSurchargePercent : 0;
  const splitRideMatchedSurchargeAmount = isMatchedSplit
    ? roundMoney(fareBeforeFees * (splitRideMatchedSurchargePercent / 100))
    : 0;

  const platformCommissionAmount = !isSplit
    ? roundMoney(fareBeforeFees * (platformCommissionPercent / 100))
    : 0;

  const totalFare = roundMoney(
    fareBeforeFees + splitRideMatchedSurchargeAmount + platformCommissionAmount,
  );
  const vatAmount = extractIncludedVat(fareBeforeFees, platformVatPercent);
  const netBeforeVat = roundMoney(fareBeforeFees - vatAmount);

  return {
    actualFare: roundMoney(rawComponentFare),
    fareBeforeFees,
    minimumFareAdjustment,
    minimumFareApplied,
    splitRideMatchedSurchargePercent: splitPercent,
    splitRideMatchedSurchargeAmount,
    splitSurchargePercent: splitPercent,
    splitSurchargeAmount: splitRideMatchedSurchargeAmount,
    platformCommissionPercent: isSplit ? 0 : platformCommissionPercent,
    platformCommissionAmount,
    platformVatPercent: platformVatPercent,
    vatAmount,
    vatIncluded: true,
    netBeforeVat,
    fareBeforePlatformCommission: fareBeforeFees,
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

  if (rideType === 'private') {
    return roundMoney(total / (1 + platformCommissionPercent / 100));
  }

  return total;
};
