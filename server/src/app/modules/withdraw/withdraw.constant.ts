export const WITHDRAW_STATUS = {
  pending: 'pending',
  completed: 'completed',
  cancelled: 'cancelled',
} as const

export type TWithdrawStatus = keyof typeof WITHDRAW_STATUS

