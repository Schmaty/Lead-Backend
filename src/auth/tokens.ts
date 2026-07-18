import jwt from 'jsonwebtoken'
import type { Role } from '@prisma/client'
import type { AppConfig } from '../config.js'
import { sha256Hex } from '../crypto/hashing.js'

const ISSUER = 'leadline-api'

export interface AccessClaims {
  sub: string
  workspaceId: string
  role: Role
}

export function signAccessToken(
  user: { id: string; workspaceId: string; role: Role },
  config: AppConfig,
): string {
  return jwt.sign({ purpose: 'access', workspaceId: user.workspaceId, role: user.role }, config.jwtAccessSecret, {
    subject: user.id,
    expiresIn: config.accessTokenTtlSec,
    issuer: ISSUER,
  })
}

export function verifyAccessToken(token: string, config: AppConfig): AccessClaims {
  const payload = jwt.verify(token, config.jwtAccessSecret, { issuer: ISSUER }) as jwt.JwtPayload
  if (payload.purpose !== 'access' || typeof payload.sub !== 'string') {
    throw new Error('Wrong token purpose')
  }
  return { sub: payload.sub, workspaceId: payload.workspaceId as string, role: payload.role as Role }
}

export interface InviteClaims {
  workspaceId: string
  email: string
  role: 'ADMIN' | 'MEMBER'
}

export function signInviteToken(claims: InviteClaims, config: AppConfig): string {
  return jwt.sign({ purpose: 'invite', ...claims }, config.jwtRefreshSecret, {
    expiresIn: config.inviteTokenTtlSec,
    issuer: ISSUER,
  })
}

export function verifyInviteToken(token: string, config: AppConfig): InviteClaims {
  const payload = jwt.verify(token, config.jwtRefreshSecret, { issuer: ISSUER }) as jwt.JwtPayload
  if (payload.purpose !== 'invite') throw new Error('Wrong token purpose')
  return {
    workspaceId: payload.workspaceId as string,
    email: payload.email as string,
    role: payload.role as 'ADMIN' | 'MEMBER',
  }
}

export interface GmailConnectClaims {
  workspaceId: string
  userId: string
}

/**
 * Short-lived state token for the Google OAuth connect flow — proves the
 * callback belongs to a connect started by a signed-in OWNER/ADMIN.
 */
export function signGmailConnectToken(claims: GmailConnectClaims, config: AppConfig): string {
  return jwt.sign({ purpose: 'gmail_connect', workspaceId: claims.workspaceId, userId: claims.userId }, config.jwtAccessSecret, {
    expiresIn: 600,
    issuer: ISSUER,
  })
}

export function verifyGmailConnectToken(token: string, config: AppConfig): GmailConnectClaims {
  const payload = jwt.verify(token, config.jwtAccessSecret, { issuer: ISSUER }) as jwt.JwtPayload
  if (payload.purpose !== 'gmail_connect') throw new Error('Wrong token purpose')
  return { workspaceId: payload.workspaceId as string, userId: payload.userId as string }
}

/** State token for the Microsoft/Outlook OAuth connect flow (mirror of Gmail's). */
export function signMicrosoftConnectToken(claims: GmailConnectClaims, config: AppConfig): string {
  return jwt.sign({ purpose: 'microsoft_connect', workspaceId: claims.workspaceId, userId: claims.userId }, config.jwtAccessSecret, {
    expiresIn: 600,
    issuer: ISSUER,
  })
}

export function verifyMicrosoftConnectToken(token: string, config: AppConfig): GmailConnectClaims {
  const payload = jwt.verify(token, config.jwtAccessSecret, { issuer: ISSUER }) as jwt.JwtPayload
  if (payload.purpose !== 'microsoft_connect') throw new Error('Wrong token purpose')
  return { workspaceId: payload.workspaceId as string, userId: payload.userId as string }
}

/**
 * Password-reset tokens embed a fingerprint of the current password hash so a
 * token stops working the moment the password changes (single-use in effect).
 */
export function signResetToken(user: { id: string; passwordHash: string }, config: AppConfig): string {
  return jwt.sign(
    { purpose: 'password_reset', pwv: sha256Hex(user.passwordHash).slice(0, 16) },
    config.jwtRefreshSecret,
    { subject: user.id, expiresIn: config.resetTokenTtlSec, issuer: ISSUER },
  )
}

export function verifyResetToken(token: string, config: AppConfig): { userId: string; pwv: string } {
  const payload = jwt.verify(token, config.jwtRefreshSecret, { issuer: ISSUER }) as jwt.JwtPayload
  if (payload.purpose !== 'password_reset' || typeof payload.sub !== 'string') {
    throw new Error('Wrong token purpose')
  }
  return { userId: payload.sub, pwv: payload.pwv as string }
}
