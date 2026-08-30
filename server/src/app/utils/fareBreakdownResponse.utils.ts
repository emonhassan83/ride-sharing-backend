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
  const resolvedRide =
    ride && typeof ride === 'object' && 'type' in ride ? ride : passenger?.rideId;

  const settingMap = await getNumberSetting([
    'platformVat',
    'platformCommissionPercent',
    'baseFare',
    'fivePassengerExtraChargePercentage',
    'sixPassengerExtraChargePercentage',
    'splitRideMatchedSurchargePercent',
  ]);

  const vatPercentage = settingMap.get('platformVat') ?? 0;
  const platformCommissionPercentage = settingMap.get('platformCommissionPercent') ?? 0;
  const baseFare = settingMap.get('baseFare') ?? 0;
  const defaultSplitRideMatchedSurchargePercent =
    settingMap.get('splitRideMatchedSurchargePercent') ?? 0;
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
  const isSplitRide = resolvedRide?.type === 'split';

  const storedSplitSurchargePercent = round2(
    passenger?.surchargePercent || resolvedRide?.currentSurchargePercent || 0,
  );
  const storedSplitSurchargeAmount = round2(passenger?.surchargeAmount || 0);

  const splitRideMatchedSurchargePercent = isSplitRide
    ? storedSplitSurchargePercent || defaultSplitRideMatchedSurchargePercent
    : 0;

  const passengerCountExtra = round2(fivePassengerExtraCharge + sixPassengerExtraCharge);

  const rawComponentFare = round2(
    initialCharge +
      totalKmCharge +
      luggageCharge +
      holidaySurcharge +
      waitingCharge +
      fivePassengerExtraCharge +
      sixPassengerExtraCharge,
  );

  const actualFare = rawComponentFare;
  const fareBeforeFees = round2(Math.max(rawComponentFare, baseFare));
  const splitRideMatchedSurchargeAmount = isSplitRide
    ? storedSplitSurchargeAmount > 0
      ? storedSplitSurchargeAmount
      : round2(fareBeforeFees * (splitRideMatchedSurchargePercent / 100))
    : 0;

  const vatAmount = round2(fareBeforeFees * (vatPercentage / 100));
  const platformCommissionAmount = round2(
    fareBeforeFees * (platformCommissionPercentage / 100),
  );
  const totalFare = round2(
    fareBeforeFees + vatAmount + platformCommissionAmount,
  );
  const minimumFareAdjustment = round2(Math.max(baseFare - actualFare, 0));

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
    platformVatPercent: vatPercentage,
    vat: vatAmount,
    vatAmount,

    platformCommissionPercentage,
    platformCommissionPercent: platformCommissionPercentage,
    platformCommissionAmount,
    platformCommission: platformCommissionAmount,

    splitSurchargePercent: splitRideMatchedSurchargePercent,
    splitSurchargeAmount: splitRideMatchedSurchargeAmount,
    splitRideMatchedSurchargePercent,
    splitRideMatchedSurchargeAmount,

    estimatedFare: totalFare,
    totalFare,
  };
};
