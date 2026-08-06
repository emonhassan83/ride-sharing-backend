export const USER_ROLE = {
  admin: 'admin',
  provider: 'provider',
  user: 'user',
} as const

export const REGISTER_WITH = {
  google: 'google',
  apple: 'apple',
  credentials: 'credentials',
}

export const USER_STATUS = {
  pending: 'pending',
  active: 'active',
  blocked: 'blocked',
} as const

export const PROVIDER_TYPE = {
  selfEmployed: 'self-employed',
  company: 'company',
} as const
export const GENDER = {
  male: 'male',
  female: 'female',
  other: 'other',
} as const

export const registerWith = [
  REGISTER_WITH.google,
  REGISTER_WITH.apple,
  REGISTER_WITH.credentials,
]

export type TUserRole = keyof typeof USER_ROLE
export type TUserStatus = keyof typeof USER_STATUS
export type TGender = keyof typeof GENDER
export type TProviderType = (typeof PROVIDER_TYPE)[keyof typeof PROVIDER_TYPE]

