export const REFUND_STATUS = {
  pending: 'pending',
  confirmed: 'confirmed',
  rejected: 'rejected'
 } as const

export const REFUND_TYPE = {
  cancel_ride: 'cancel_ride',
  split_ride: 'split_ride'
 } as const

 export type TRefundType = keyof typeof REFUND_TYPE
 export type TRefundStatus = keyof typeof REFUND_STATUS