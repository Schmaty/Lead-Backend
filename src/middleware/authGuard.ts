import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Role } from '@prisma/client'
import { verifyAccessToken } from '../auth/tokens.js'
import type { AppConfig } from '../config.js'
import { AppError } from './errorHandler.js'

/** True when the email is on the platform developer allowlist (DEVELOPER_EMAILS). */
export function isDeveloper(config: AppConfig, email: string): boolean {
  return config.developerEmails.includes(email.toLowerCase())
}

/**
 * preHandler: requires a valid Bearer access token and loads the current user.
 * The user is re-read from the DB so role changes and deletions apply immediately.
 */
export function authGuard(app: FastifyInstance) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError(401, 'Missing access token')
    }
    let claims
    try {
      claims = verifyAccessToken(header.slice('Bearer '.length), app.config)
    } catch {
      throw new AppError(401, 'Invalid or expired access token')
    }
    const user = await app.prisma.user.findUnique({ where: { id: claims.sub } })
    if (!user || user.workspaceId !== claims.workspaceId) {
      throw new AppError(401, 'Invalid access token')
    }
    request.auth = {
      userId: user.id,
      workspaceId: user.workspaceId,
      role: user.role,
      name: user.name,
      email: user.email,
    }
  }
}

/** preHandler: requires one of the given roles. Must run after authGuard. */
export function requireRole(...roles: Role[]) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.auth) throw new AppError(401, 'Missing access token')
    if (!roles.includes(request.auth.role)) {
      throw new AppError(403, `Requires role: ${roles.join(' or ')}`)
    }
  }
}

/**
 * preHandler: requires the allowlisted developer account. Must run after
 * authGuard. Platform credentials, ingest API keys, and raw workspace secrets
 * are developer territory — clients connect integrations by signing in, not
 * by pasting keys.
 */
export function requireDeveloper(app: FastifyInstance) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.auth) throw new AppError(401, 'Missing access token')
    if (!isDeveloper(app.config, request.auth.email)) {
      throw new AppError(403, 'Requires the developer account')
    }
  }
}
