import { Setting } from '../modules/settings/settings.model';
import { buildPassengerFareTotals, roundMoney } from './fareMath.utils';

const getNumberSetting = async (keys: string[]) => {
  const settings = await Setting.find({ key: { $in: keys } }).lean();
  return new Map(settings.map((setting: any) => [setting.key, Number(setting.value)]));
};

export const buildStoredFareBreakdown = async (
  passenger: any,
  booking?: any,
  ride?: any,
) => {
  const resolvedRide =
    ride && typeof ride === 'object' && 'type' in ride ? ride : passenger?.rideId;

  const settingMap = await getNumberSetting([
    'platformVat',
    'platformCommissionPercent',
    'baseFare',
    'fivePassengerExtraChargePercentage',
    'sixPassengerExtraChargePercentage',
    'splitRideMatchedSurchargePercent',
    'fareRoundingBracket',
  ]);

  const vatPercentage = settingMap.get('platformVat') ?? 9;
  const platformCommissionPercentage = settingMap.get('platformCommissionPercent') ?? 10;
  const baseFare = settingMap.get('baseFare') ?? 0;
  const defaultSplitRideMatchedSurchargePercent =
    settingMap.get('splitRideMatchedSurchargePercent') ?? 0;
  const fareRoundingBracket = settingMap.get('fareRoundingBracket') ?? 5;
  const fivePassengerExtraChargePercentage =
    settingMap.get('fivePassengerExtraChargePercentage') ?? 0;
  const sixPassengerExtraChargePercentage =
    settingMap.get('sixPassengerExtraChargePercentage') ?? 0;

  const initialCharge = roundMoney(passenger?.initialCharge);
  const perKmCharge = roundMoney(passenger?.perKmCharge);
  const totalKmCharge = roundMoney(passenger?.totalKmCharge);
  const luggageCharge = roundMoney(passenger?.luggageCharge);
  const holidaySurcharge = roundMoney(passenger?.holidayTripCharge);
  const waitingCharge = roundMoney(passenger?.waitingCharge);
  const fivePassengerExtraCharge = roundMoney(passenger?.fivePassengerCharge || 0);
  const sixPassengerExtraCharge = roundMoney(passenger?.sixPassengerCharge || 0);
  const isSplitRide = resolvedRide?.type === 'split';

  const passengerCountExtra = roundMoney(
    fivePassengerExtraCharge + sixPassengerExtraCharge,
  );

  const rawComponentFare = roundMoney(
    initialCharge +
      totalKmCharge +
      luggageCharge +
      holidaySurcharge +
      waitingCharge +
      fivePassengerExtraCharge +
      sixPassengerExtraCharge,
  );

  const storedSurchargeAmount = isSplitRide
    ? roundMoney(passenger?.surchargeAmount || 0)
    : 0;
  const storedSurchargePercent = isSplitRide
    ? roundMoney(
        passenger?.surchargePercent ||
          resolvedRide?.currentSurchargePercent ||
          defaultSplitRideMatchedSurchargePercent,
      )
    : 0;

  const fareTotals = buildPassengerFareTotals({
    rideType: isSplitRide ? 'split' : 'private',
    riderCount: isSplitRide ? (storedSurchargeAmount > 0 ? 2 : 1) : 1,
    rawComponentFare,
    baseFare,
    platformVatPercent: vatPercentage,
    platformCommissionPercent: platformCommissionPercentage,
    splitRideMatchedSurchargePercent: defaultSplitRideMatchedSurchargePercent,
    fareRoundingBracket,
  });

  const splitRideMatchedSurchargePercent = isSplitRide
    ? storedSurchargePercent || fareTotals.splitRideMatchedSurchargePercent
    : 0;
  const splitRideMatchedSurchargeAmount = isSplitRide
    ? storedSurchargeAmount || fareTotals.splitRideMatchedSurchargeAmount
    : 0;

  let totalFare = fareTotals.totalFare;
  let platformCommissionAmount = fareTotals.platformCommissionAmount;
  let vatAmount = fareTotals.vatAmount;

  if (isSplitRide && storedSurchargeAmount > 0) {
    const { fareBeforeFees } = fareTotals;
    totalFare = roundMoney(fareBeforeFees + storedSurchargeAmount);
    platformCommissionAmount = 0;
    vatAmount = fareTotals.vatAmount;
  } else if (!isSplitRide && (passenger?.totalFare || booking?.totalFare)) {
    totalFare = roundMoney(
      Number(passenger?.totalFare || booking?.totalFare || fareTotals.totalFare),
    );
  }

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
    actualFare: fareTotals.actualFare,
    fareBeforeFees: fareTotals.fareBeforeFees,
    minimumFareApplied: fareTotals.minimumFareApplied,
    minimumFareAdjustment: fareTotals.minimumFareAdjustment,

    vatPercentage,
    platformVatPercent: vatPercentage,
    vatIncluded: true,
    vat: vatAmount,
    vatAmount,
    netBeforeVat: fareTotals.netBeforeVat,

    platformCommissionPercentage: isSplitRide ? 0 : platformCommissionPercentage,
    platformCommissionPercent: isSplitRide ? 0 : platformCommissionPercentage,
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
