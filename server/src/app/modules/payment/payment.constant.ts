export enum PAYMENT_STATUS {
  unpaid = 'unpaid',
  paid = 'paid',
  refunded = 'refunded',
  failed = 'failed',
}

export type TPaymentStatus = keyof typeof PAYMENT_STATUS