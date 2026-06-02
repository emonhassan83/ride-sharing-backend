export const CHAT_STATUS = {
  accepted: 'accepted',
  blocked: 'blocked'
} as const

export type TChatStatus = keyof typeof CHAT_STATUS