export const CONTRACT_BY = {
  phone: 'phone',
  email: 'email'
} as const

export const SUPPORT_STATUS = {
  pending: 'pending',
  replied: 'replied',
  resolved: 'resolved'
} as const

export type TContractBy = keyof typeof CONTRACT_BY
export type TSupportStatus = keyof typeof SUPPORT_STATUS
