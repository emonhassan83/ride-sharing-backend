import { Setting } from '../modules/settings/settings.model';

const round2 = (value: any): number => {
  const numeric = Number(value || 0);
  return Math.round(numeric * 100) / 100;
};

const getNumberSetting = async (keys: string[]) => {
  const settings = await Setting.find({ key: { $in: keys } }).lean();
  return new Map(settings.map((setting: any) => [setting.key, Number(setting.value)]));
};

export const buildStoredFareBreakdown = async (passenger: any, booking?: any, ride?: any) => {
  const settingMap = await getNumberSetting([
    'platformVat',
    'platformCommissionPercent',
    'baseFare',
    'fivePassengerExtraChargePercentage',
    'sixPassengerExtraChargePercentage',
  ]);

  const vatPercentage = settingMap.get('platformVat') ?? 0;
  const platformCommissionPercentage = settingMap.get('platformCommissionPercent') ?? 0;
  const baseFare = settingMap.get('baseFare') ?? 0;
  const fivePassengerExtraChargePercentage =
    settingMap.get('fivePassengerExtraChargePercentage') ?? 0;
  const sixPassengerExtraChargePercentage =
    settingMap.get('sixPassengerExtraChargePercentage') ?? 0;

  const initialCharge = round2(passenger?.initialCharge);
  const perKmCharge = round2(passenger?.perKmCharge);
  const totalKmCharge = round2(passenger?.totalKmCharge);
  const luggageCharge = round2(passenger?.luggageCharge);
  const holidaySurcharge = round2(passenger?.holidayTripCharge);
  const waitingCharge = round2(passenger?.waitingCharge);
  const fivePassengerExtraCharge = round2(passenger?.fivePassengerCharge || 0);
  const sixPassengerExtraCharge = round2(passenger?.sixPassengerCharge || 0);
  const splitSurchargePercent = round2(
    passenger?.surchargePercent || ride?.currentSurchargePercent || 0
  );
  const splitSurchargeAmount = round2(passenger?.surchargeAmount || 0);
  const passengerCountExtra = round2(fivePassengerExtraCharge + sixPassengerExtraCharge);

  const actualFare = round2(
    initialCharge +
      totalKmCharge +
      luggageCharge +
      holidaySurcharge +
      waitingCharge +
      fivePassengerExtraCharge +
      sixPassengerExtraCharge +
      splitSurchargeAmount
  );

  const isSplitRide = ride?.type === 'split' || splitSurchargePercent > 0;
  const storedFare = round2(
    passenger?.totalFare || passenger?.estimatedFare || booking?.totalFare || 0
  );

  // Private ride: minimum base fare applies before VAT/platform commission.
  // Split ride: stored fare is already the per-rider split amount after matched
  // surcharge, so do not apply the private minimum again per passenger.
  const fareBeforeFees = isSplitRide
    ? round2(storedFare || actualFare)
    : round2(Math.max(actualFare, baseFare));

  const vatAmount = isSplitRide
    ? round2(passenger?.vat || 0)
    : round2(fareBeforeFees * (vatPercentage / 100));
  const platformCommissionAmount = round2(
    fareBeforeFees * (platformCommissionPercentage / 100)
  );
  const totalFare = isSplitRide
    ? round2(storedFare || fareBeforeFees + vatAmount)
    : round2(fareBeforeFees + vatAmount + platformCommissionAmount);
  const minimumFareAdjustment = isSplitRide ? 0 : round2(Math.max(baseFare - actualFare, 0));

  return {
    initialCharge,
    perKmCharge,
    totalKmCharge,
    luggageCharge,
    holidaySurcharge,
    waitingCharge,
    passengerCountExtra,

    fivePassengerExtraCharge,
    sixPassengerExtraCharge,
    fivePassengerExtraChargePercentage,
    sixPassengerExtraChargePercentage,

    baseFare,
    actualFare,
    fareBeforeFees,
    minimumFareApplied: minimumFareAdjustment > 0,
    minimumFareAdjustment,

    vatPercentage,
    vat: vatAmount,

    platformCommissionPercentage,
    platformCommissionAmount,

    splitSurchargePercent,
    splitSurchargeAmount,

    estimatedFare: totalFare,
    totalFare,
  };
};