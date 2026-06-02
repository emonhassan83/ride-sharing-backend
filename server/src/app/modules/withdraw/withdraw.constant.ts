export const WITHDRAW_STATUS = {
  proceed: 'proceed',
  completed: 'completed',
  hold: 'hold',
} as const

export type TWithdrawStatus = keyof typeof WITHDRAW_STATUS