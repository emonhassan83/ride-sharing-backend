import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Setting } from './settings.model';
import { DEFAULT_GENERAL_SETTINGS, GENERAL_KEYS } from './settings.constant';

const getSetting = async (key: string) => {
  if (!key) throw new ApiError(StatusCodes.BAD_REQUEST, 'Key is required');

  const setting = await Setting.findOne({ key }).select('-__v').lean();
  if (!setting) {
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      `Setting with key "${key}" not found`,
    );
  }

  return setting;
};

const getSettingGenerals = async () => {
  const settings = await Setting.find({
    key: { $in: [...GENERAL_KEYS] },
  })
    .select('-__v')
    .lean();

  const byKey = new Map(settings.map((setting) => [setting.key, setting]));
  const missingKeys = GENERAL_KEYS.filter((key) => !byKey.has(key));

  if (missingKeys.length > 0) {
    await Setting.bulkWrite(
      missingKeys.map((key) => ({
        updateOne: {
          filter: { key },
          update: { $setOnInsert: { key, value: DEFAULT_GENERAL_SETTINGS[key] } },
          upsert: true,
        },
      })),
      { ordered: false },
    );

    const inserted = await Setting.find({ key: { $in: missingKeys } })
      .select('-__v')
      .lean();
    inserted.forEach((setting) => byKey.set(setting.key, setting));
  }

  // Migrate outdated client-required split booking defaults.
  const splitLead = byKey.get('splitRideMinBookingHours');
  if (!splitLead || Number(splitLead.value) === 24) {
    const updated = await Setting.findOneAndUpdate(
      { key: 'splitRideMinBookingHours' },
      { $set: { key: 'splitRideMinBookingHours', value: 3 } },
      { upsert: true, returnDocument: 'after' },
    ).select('-__v').lean();
    if (updated) byKey.set('splitRideMinBookingHours', updated);
  }

  if (!byKey.get('splitRideMinDistanceKm')) {
    const updated = await Setting.findOneAndUpdate(
      { key: 'splitRideMinDistanceKm' },
      { $setOnInsert: { key: 'splitRideMinDistanceKm', value: 20 } },
      { upsert: true, returnDocument: 'after' },
    ).select('-__v').lean();
    if (updated) byKey.set('splitRideMinDistanceKm', updated);
  }

  return GENERAL_KEYS.map((key) => {
    const existing = byKey.get(key);
    if (existing) return existing;
    return { key, value: DEFAULT_GENERAL_SETTINGS[key] };
  });
};

const createOrUpdate = async (key: string, payload: any) => {
  if (!key || key === 'generals') {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Key is required and cannot be "generals"',
    );
  }

  return Setting.findOneAndUpdate(
    { key },
    { $set: { key, value: payload.value ?? payload, name: payload.name } },
    { returnDocument: 'after', upsert: true },
  ).select('-__v');
};

const updateGenerals = async (payload: Record<string, any>) => {
  const validKeys = GENERAL_KEYS.filter((key) => payload[key] !== undefined);

  if (validKeys.length === 0) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'No valid general setting keys provided',
    );
  }

  await Setting.bulkWrite(
    validKeys.map((key) => ({
      updateOne: {
        filter: { key },
        update: { $set: { key, value: payload[key] } },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  const updatedSettings = await Setting.find({ key: { $in: validKeys } })
    .select('-__v')
    .lean();
  const byKey = new Map(updatedSettings.map((setting) => [setting.key, setting]));

  return validKeys.map((key) => byKey.get(key)).filter(Boolean);
};

export const SettingService = {
  getSetting,
  getSettingGenerals,
  createOrUpdate,
  updateGenerals,
};
