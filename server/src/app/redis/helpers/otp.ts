import { getRedisClient } from "../../config/redis.config";
import { REDIS_KEYS } from "../keys";

export const OtpRedisService = {
  // hashed OTP save with expiration time in seconds
  saveOtp: async (email: string, hashedOtp: string, duration: number) => {
    console.log("from radis", {email, hashedOtp, duration});
    
    await getRedisClient().set(REDIS_KEYS.REGISTER_OTP(email), hashedOtp, 'EX', duration);
  },

  // OTP get
  getOtp: async (email: string) => {
    return await getRedisClient().get(REDIS_KEYS.REGISTER_OTP(email));
  },

  // OTP delete
  deleteOtp: async (email: string) => {
    await getRedisClient().del(REDIS_KEYS.REGISTER_OTP(email));
  }
};