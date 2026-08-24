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
  console.log('✅ Settings seeded successfully');
};

export default settingSeeder;
