export const WITHDRAW_STATUS = {
  pending: 'pending',
  proceed: 'proceed',
  completed: 'completed',
  cancelled: 'cancelled',
} as const

export type TWithdrawStatus = keyof typeof WITHDRAW_STATUS