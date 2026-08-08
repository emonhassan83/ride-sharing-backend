export const PAYMENT_METHOD = {
  card: 'card',
  wallet: 'wallet'
} as const;

export enum PAYMENT_STATUS {
  unpaid = 'unpaid',
  paid = 'paid',
  authorized = 'authorized',
  requires_reauthorization = 'requires_reauthorization',
  refunded = 'refunded',
  cancelled_authorization = 'cancelled_authorization',
  failed = 'failed',
}

export type TPaymentMethod = keyof typeof PAYMENT_METHOD
export type TPaymentStatus = keyof typeof PAYMENT_STATUS