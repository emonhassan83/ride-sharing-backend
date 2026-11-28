import { TProviderType, TUserRole } from "../user/user.constant"

export interface TLoginWithEmail {
  email: string
  password: string
  fcmToken?: string
  /** Role chosen on the app's login screen. When sent, it must match the account. */
  role?: 'user' | 'provider'
}

export interface TLoginWithPhone {
  phone: string
  fcmToken?: string
  /** Role chosen on the app's login screen. When sent, it must match the account. */
  role?: 'user' | 'provider'
}

export interface TGoogleLoginPayload {
  name?: string
  email: string
  role?: TUserRole
  type?: TProviderType
  photoUrl?: string
  token?: string // Google auth token or ID token
  fcmToken?: string
}

export interface TAppleLoginPayload {
  name?: string
  email: string
  photoUrl?: string
  role?: TUserRole
  type?: TProviderType
  token?: string // Apple identity token
  fcmToken?: string
}

