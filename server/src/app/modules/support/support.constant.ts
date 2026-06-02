export const SUPPORT_STATUS = {
  pending: 'pending',
  resolved: 'resolved'
} as const

export type TSupportStatus = keyof typeof SUPPORT_STATUS
