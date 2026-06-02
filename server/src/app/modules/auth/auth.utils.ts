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
  return jwt.sign(jwtPayload, secret, { expiresIn })
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