// services/setting.service.ts
import { StatusCodes } from 'http-status-codes';
import ApiError from '../../errors/ApiError';
import { Setting } from './settings.model';
import { deleteCache, deleteCachePattern, getCache, setCache } from '../../redis/helpers';
import { GENERAL_KEYS } from './settings.constant';
import { REDIS_KEYS } from '../../redis/keys';

/**
 * Get single setting by key (with caching)
 */
const getSetting = async (key: string) => {
  if (!key) throw new ApiError(StatusCodes.BAD_REQUEST, 'Key is required');

  const cacheKey = REDIS_KEYS.SETTINGS_SINGLE(key);
  
  // 1. Try to get from cache
  const cached = await getCache<any>(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit for setting: ${key}`);
    return cached;
  }
  
  console.log(`📡 Cache miss for setting: ${key}, fetching from DB...`);
  
  // 2. Get from database
  const setting = await Setting.findOne({ key }).select('-__v').lean();
  if (!setting) {
    throw new ApiError(
      StatusCodes.NOT_FOUND,
      `Setting with key "${key}" not found`,
    );
  }
  
  // 3. Store in cache (no TTL)
  await setCache(cacheKey, setting);
  
  return setting;
};

/**
 * Get all general settings (with caching)
 */
const getSettingGenerals = async () => {
  const cacheKey = REDIS_KEYS.SETTINGS_GENERALS;
  
  // 1. Try to get from cache
  const cached = await getCache<any[]>(cacheKey);
  if (cached) {
    console.log('✅ Cache hit for general settings');
    return cached;
  }
  
  console.log('📡 Cache miss for general settings, fetching from DB...');
  
  // 2. Get from database
  const settings = await Setting.find({ key: { $in: GENERAL_KEYS } }).select('-__v').lean();
  
  // 3. Store in cache (no TTL)
  await setCache(cacheKey, settings);
  
  return settings;
};

/**
 * Create or update single setting (with cache invalidation)
 */
const createOrUpdate = async (key: string, payload: any) => {
  if (!key || key === 'generals') {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Key is required and cannot be "generals"',
    );
  }

  // 1. Update database
  const setting = await Setting.findOneAndUpdate(
    { key },
    { key, value: payload.value ?? payload, name: payload.name },
    { new: true, upsert: true },
  ).select('-__v');

  // 2. Invalidate caches (delete, not update)
  await deleteCache(REDIS_KEYS.SETTINGS_SINGLE(key));      // Delete single setting cache
  await deleteCache(REDIS_KEYS.SETTINGS_GENERALS);         // Delete generals cache
  await deleteCachePattern('setting:*');          // Delete all setting-related caches (optional)

  console.log(`🗑️ Cache invalidated for setting: ${key} and generals`);

  return setting;
};

/**
 * Update multiple general settings (with cache invalidation)
 */
const updateGenerals = async (payload: Record<string, any>) => {
  const validKeys = GENERAL_KEYS.filter(key => payload[key] !== undefined);

  if (validKeys.length === 0) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'No valid general setting keys provided',
    );
  }

  // 1. Update database
  const updates = validKeys.map(key =>
    Setting.findOneAndUpdate(
      { key },
      { value: payload[key] },
      { upsert: true, new: true },
    ).select('-__v'),
  );

  await Promise.all(updates);

  // 2. Invalidate caches
  await deleteCache(REDIS_KEYS.SETTINGS_GENERALS);              // Delete generals cache
  
  // Delete each individual setting cache
  for (const key of validKeys) {
    await deleteCache(REDIS_KEYS.SETTINGS_SINGLE(key));
  }
  
  // Also delete pattern (safety)
  await deleteCachePattern('setting:*');

  console.log(`🗑️ Cache invalidated for ${validKeys.length} general settings`);
};


export const SettingService = {
  getSetting,
  getSettingGenerals,
  createOrUpdate,
  updateGenerals
};