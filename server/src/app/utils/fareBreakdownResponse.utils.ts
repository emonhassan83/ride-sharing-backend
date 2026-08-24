import { Setting } from '../modules/settings/settings.model';

const round2 = (value: any): number => {
  const numeric = Number(value || 0);
  return Math.round(numeric * 100) / 100;
};

const getNumberSetting = async (keys: string[]) => {
  const settings = await Setting.find({ key: { $in: keys } }).lean();
  return new Map(settings.map((setting: any) => [setting.key, Number(setting.value)]));
};

export const buildStoredFareBreakdown = async (passenger: any, booking?: any) => {
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

  const grossFare = round2(
    passenger?.totalFare || passenger?.estimatedFare || booking?.totalFare || 0
  );
  const totalPercent = vatPercentage + platformCommissionPercentage;
  const fareBeforeFees = totalPercent > 0
    ? round2(grossFare / (1 + totalPercent / 100))
    : grossFare;

  const vatAmount = round2(passenger?.vat ?? fareBeforeFees * (vatPercentage / 100));
  const platformCommissionAmount = round2(
    fareBeforeFees * (platformCommissionPercentage / 100)
  );

  const fivePassengerExtraCharge = round2(passenger?.fivePassengerCharge || 0);
  const sixPassengerExtraCharge = round2(passenger?.sixPassengerCharge || 0);

  return {
    initialCharge: round2(passenger?.initialCharge),
    perKmCharge: round2(passenger?.perKmCharge),
    totalKmCharge: round2(passenger?.totalKmCharge),
    luggageCharge: round2(passenger?.luggageCharge),
    holidaySurcharge: round2(passenger?.holidayTripCharge),
    waitingCharge: round2(passenger?.waitingCharge),

    fivePassengerExtraCharge,
    sixPassengerExtraCharge,
    fivePassengerExtraChargePercentage,
    sixPassengerExtraChargePercentage,

    baseFare,
    fareBeforeFees,

    vatPercentage,
    platformVatPercent: vatPercentage,
    vatAmount,
    vat: vatAmount,

    platformCommissionPercentage,
    platformCommissionPercent: platformCommissionPercentage,
    platformCommissionAmount,
    platformCommission: platformCommissionAmount,

    estimatedFare: grossFare,
    totalFare: grossFare,
  };
};
