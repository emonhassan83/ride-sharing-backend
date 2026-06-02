export const AUDIENCE = {
  provider: 'provider',
  user: 'user',
} as const

export type TAudience = keyof typeof AUDIENCE