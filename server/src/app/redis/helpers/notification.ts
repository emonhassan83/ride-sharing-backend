import { getRedisClient } from "../../config/redis.config";
import { REDIS_KEYS } from "../keys";

export const incrementUnreadCount = async (userId: string) => {
  const key = REDIS_KEYS.UNREAD_NOTIFICATION(userId);
  await getRedisClient().incr(key);
  // 30 days set expiration for the unread count key
  await getRedisClient().expire(key, 2592000); 
};

export const decrementUnreadCount = async (userId: string,  decrementBy: number = 1): Promise<number> => {
  const key = REDIS_KEYS.UNREAD_NOTIFICATION(userId);
  const newCount = await getRedisClient().decrby(key, decrementBy);
  // handle case where count might go negative due to multiple deletions or inconsistencies
  if (newCount < 0) {
    await getRedisClient().set(key, 0);
    return 0;
  }
  return newCount;
}

export const setUnreadCountInRedis = async (userId: string, count: number): Promise<void> => {
  const key = REDIS_KEYS.UNREAD_NOTIFICATION(userId);
  await getRedisClient().set(key, count);
};

export const resetUnreadCount = async (userId: string) => {
  const key = REDIS_KEYS.UNREAD_NOTIFICATION(userId);
  await getRedisClient().set(key, 0);
};

export const getUnreadCount = async (userId: string): Promise<number> => {
  const key = REDIS_KEYS.UNREAD_NOTIFICATION(userId);
  const count = await getRedisClient().get(key);
  return count ? parseInt(count) : 0;
};