export const REFUND_STATUS = {
  pending: 'pending',
  confirmed: 'confirmed',
  rejected: 'rejected'
 } as const

 export type TRefundStatus = keyof typeof REFUND_STATUS