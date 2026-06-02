import { TUserRole } from "../user/user.constant"

export interface TLoginWithEmail {
  email: string
  password: string
  fcmToken?: string
}

export interface TLoginWithPhone {
  phone: string
  fcmToken?: string
}

export interface TGoogleLoginPayload {
  name?: string
  email: string
  role?: TUserRole
  photoUrl?: string
  token?: string // Google auth token or ID token
  fcmToken?: string
}

export interface TAppleLoginPayload {
  name?: string
  email: string
  photoUrl?: string
  role?: TUserRole
  token?: string // Apple identity token
  fcmToken?: string
}
