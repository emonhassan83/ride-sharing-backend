export const PROVIDER_STATUS = {
  pending: 'pending',
  verified: 'verified',
  rejected: 'rejected',
} as const

export type TProviderStatus = keyof typeof PROVIDER_STATUS

