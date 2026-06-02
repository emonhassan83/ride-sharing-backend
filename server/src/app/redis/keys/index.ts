export const REDIS_KEYS = {
  VEHICLES_BY_USER: (userId: string) => `vehicles:${userId}`,

  CONTENTS: 'contents_cache',

  UNREAD_NOTIFICATION: (userId: string) => `unread_count:${userId}`,

  REGISTER_OTP: (email: string) => `register:otp:${email}`,
  RESET_OTP: (email: string) => `reset:otp:${email}`,

  SETTINGS_SINGLE: (key: string) => `setting:${key}`,
  SETTINGS_GENERALS: 'setting:generals',

  FAQ_ALL: 'faq:all',
  
  FAQ_BY_AUDIENCE: (audience: string) => `faq:audience:${audience}`,

  SAVED_PLACES_BY_USER: (userId: string) => `savedPlaces:${userId}`,

  REVIEWS_ALL: 'reviews:all',
  REVIEWS_BY_USER: (userId: string) => `reviews:${userId}`,


  SUPPORT_ALL: 'support:all',
  SUPPORT_SINGLE: (id: string) => `support:${id}`,

  ACCOUNT_DELETION_ALL: 'accountDeletion:all',
  ACCOUNT_DELETION_SINGLE: (id: string) => `accountDeletion:${id}`
} as const
