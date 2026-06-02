export const OTP_TYPE = {
  signUp: 'signUp',
  forgot: 'forgot',
  login: 'login',
} as const

export type TUserRole = keyof typeof OTP_TYPE
