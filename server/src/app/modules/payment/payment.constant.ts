export const PAYMENT_METHOD = {
  stripe: 'stripe',
  wallet: 'wallet'
} as const;

export enum PAYMENT_STATUS {
  unpaid = 'unpaid',
  paid = 'paid',
  refunded = 'refunded',
  failed = 'failed',
}

export type TPaymentMethod = keyof typeof PAYMENT_METHOD
export type TPaymentStatus = keyof typeof PAYMENT_STATUS