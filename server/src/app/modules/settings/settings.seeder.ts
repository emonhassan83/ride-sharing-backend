import { Setting } from './settings.model';
import { DEFAULT_GENERAL_SETTINGS } from './settings.constant';

const settingSeeder = async () => {
  const settingsData: { key: string; value: unknown }[] = [
    ...Object.entries(DEFAULT_GENERAL_SETTINGS).map(([key, value]) => ({
      key,
      value,
    })),
    {
      key: 'userTramsAndCondition',
      value: 'Full trams and condition content goes here...',
    },
    {
      key: 'providerTramsAndCondition',
      value: 'Full trams and condition content goes here...',
    },
  ];

  const bulkOps = settingsData.map((setting) => ({
    updateOne: {
      filter: { key: setting.key },
      update: { $setOnInsert: setting },
      upsert: true,
    },
  }));

  await Setting.bulkWrite(bulkOps);

  // Client-required split booking defaults (force-update known outdated values).
  await Setting.bulkWrite([
    {
      updateOne: {
        filter: { key: 'splitRideMinBookingHours' },
        update: { $set: { key: 'splitRideMinBookingHours', value: 3 } },
        upsert: true,
      },
    },
    {
      updateOne: {
        filter: { key: 'splitRideMinDistanceKm' },
        update: { $set: { key: 'splitRideMinDistanceKm', value: 20 } },
        upsert: true,
      },
    },
    {
      updateOne: {
        filter: { key: 'perLuggageCharge' },
        update: { $set: { key: 'perLuggageCharge', value: 1.4 } },
        upsert: true,
      },
    },
    {
      updateOne: {
        filter: { key: 'splitRideMatchedSurchargePercent3' },
        update: { $set: { key: 'splitRideMatchedSurchargePercent3', value: 50 } },
        upsert: true,
      },
    },
    {
      updateOne: {
        filter: { key: 'splitRideMaxMatchedRiders' },
        update: { $set: { key: 'splitRideMaxMatchedRiders', value: 3 } },
        upsert: true,
      },
    },
  ]);

  console.log('✅ Settings seeded successfully');
};

export default settingSeeder;
