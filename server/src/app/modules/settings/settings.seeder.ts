import { Setting } from './settings.model';

const settingSeeder = async () => {
  const settingsData = [
      // Access & validation ride
    { key: 'bookingMaxDaysAhead', value: 30 },
    { key: 'bookingMinDaysAhead', value: 2 },
    { key: 'matchingNoDriverNotifyHours', value: 48 },
    { key: 'matchingLastNotifyHours', value: 24 },
    { key: 'cancellationFreeWindowHours', value: 24 },
    { key: 'cancellationPercentage50Hours', value: 3 },
    { key: 'waitingReminderIntervals', value: 2 },

    // ride & charge
    { key: 'dayFareInitialCharge', value: 3.8 },
    { key: 'dayFarePerKMRate', value: 0.95 },
    { key: 'dayFareWaitingCharge', value: 17 },
    { key: 'nightFareInitialCharge', value: 4.80 },
    { key: 'nightFarePerKMRate', value: 1.1 },
    { key: 'nightFareWaitingCharge', value: 19 },
    { key: 'holidayIncreasePercentage', value: 20 },
    { key: 'perLuggageCharge', value: 2 },
    { key: 'fivePassengerExtraCharge', value: 1.4 },
    { key: 'sixPassengerExtraChargePercentage', value: 40 },
    { key: 'platformVat', value: 9 },
    { key: 'platformCommissionPercent', value: 10 },

    // platform info
    { key: 'supportContract', value: '+357XXXXXXXX' },
    { key: 'supportEmail', value: 'support@yourapp.com' },

    // Trams & Condition
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
