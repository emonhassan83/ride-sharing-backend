import { getRedisClient } from "../../config/redis.config";


/**
 * Get cached data by key
 */
export const getCache = async <T>(key: string): Promise<T | null> => {
  try {
    const data = await getRedisClient().get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error(`Cache get error for key ${key}:`, error);
    return null;
  }
};

/**
 * Set data in cache (no TTL - permanent)
 */
export const setCache = async (key: string, value: any, ttl?: number): Promise<void> => {
  try {
    if (ttl) {
      await getRedisClient().set(key, JSON.stringify(value), 'EX', ttl);
    } else {
      await getRedisClient().set(key, JSON.stringify(value));
    }
  } catch (error) {
    console.error(`Cache set error for key ${key}:`, error);
  }
};

/**
 * Delete single cache key
 */
export const deleteCache = async (key: string): Promise<void> => {
  try {
    await getRedisClient().del(key);
  } catch (error) {
    console.error(`Cache delete error for key ${key}:`, error);
  }
};

/**
 * Delete multiple cache keys by pattern
 * Example: deleteCachePattern('setting:*') will delete all setting keys
 */
export const deleteCachePattern = async (pattern: string): Promise<void> => {
  try {
    const keys = await getRedisClient().keys(pattern);
    if (keys.length > 0) {
      await getRedisClient().del(...keys);
    }
  } catch (error) {
    console.error(`Cache delete pattern error for ${pattern}:`, error);
  }
};

/**
 * Check if cache key exists
 */
export const cacheExists = async (key: string): Promise<boolean> => {
  try {
    const result = await getRedisClient().exists(key);
    return result === 1;
  } catch (error) {
    console.error(`Cache exists error for key ${key}:`, error);
    return false;
  }
};