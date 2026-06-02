import { Setting } from './settings.model';

const settingSeeder = async () => {
  const settingsData = [
    { key: 'dayFareInitialCharge', value: 50 },
    { key: 'dayFarePerKMRate', value: 12 },
    { key: 'dayFareWaitingCharge', value: 3 },
    { key: 'nightFareInitialCharge', value: 70 },
    { key: 'nightFarePerKMRate', value: 15 },
    { key: 'nightFareWaitingCharge', value: 4 },
    { key: 'publicHolidayIncrease', value: 25 },
    { key: 'perLuggageCharge', value: 10 },
    { key: 'fourPassengerTaxiTax', value: 100 },
    { key: 'sixPassengerTaxiTaxPercentage', value: 15 },
    { key: 'platformVat', value: 5 },
    { key: 'supportContract', value: 'Standard support contract terms' },
    { key: 'supportEmail', value: 'support@yourapp.com' },
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
