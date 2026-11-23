import jwt from 'jsonwebtoken'
import { Types } from 'mongoose'
import { TUser } from '../user/user.interface';
import { config } from '../../config/env.config';

export type TExpiresIn =
  | number
  | '30s'
  | '1m'
  | '5m'
  | '10m'
  | '1h'
  | '1d'
  | '7d'
  | '30d'
  | '365d'

export const createToken = (
  jwtPayload: { userId: Types.ObjectId; email: string; role: string },
  secret: string,
  expiresIn: TExpiresIn,
) => {
  // `iatMs`: millisecond issue time. JWT `iat` is in whole seconds, which cannot
  // tell a token issued just before logout from one issued just after re-login.
  return jwt.sign({ ...jwtPayload, iatMs: Date.now() }, secret, { expiresIn })
}

export const SESSION_ENDED_MESSAGE = 'Your session has ended. Please log in again.'

/**
 * Issue 15: logout must end the session everywhere. Logout stamps
 * `user.tokensValidAfter`; any token issued before that moment is rejected by
 * the REST `auth` middleware, the socket handshake and the refresh endpoint.
 */
export const isTokenRevoked = (
  decoded: { iatMs?: unknown; iat?: unknown } | null | undefined,
  tokensValidAfter?: Date | string | null,
): boolean => {
  if (!tokensValidAfter) return false
  const validAfterMs = new Date(tokensValidAfter).getTime()
  if (!Number.isFinite(validAfterMs)) return false
  const issuedAtMs =
    typeof decoded?.iatMs === 'number'
      ? decoded.iatMs
      : typeof decoded?.iat === 'number'
        ? decoded.iat * 1000
        : 0
  return issuedAtMs < validAfterMs
}

export const verifyToken = (token: string, secret: string) => {
  return jwt.verify(token, secret) as jwt.JwtPayload
}

export const generateTokens = (user: TUser) => {
  const jwtPayload = { userId: user._id, email: user.email, role: user.role }

  const userResponse = {
    name: user.name,
    email: user.email,
    role: user.role,
    isProfileComplete: user.isProfileComplete,
    status: user.status,
    registerWith: user.registerWith
  }

  const accessToken = createToken(
     jwtPayload,
    config.jwt.accessSecret as string,
    config.jwt.accessExpiration as TExpiresIn,
  )

  const refreshToken = createToken(
     jwtPayload,
    config.jwt.refreshSecret as string,
    config.jwt.refreshExpiration as TExpiresIn,
  )

  return { user: userResponse, accessToken, refreshToken }
}