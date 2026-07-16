import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { User } from '@prisma/client'
import { z } from 'zod'
import type { AppConfig } from '../config.js'
import { hashPassword, sha256Hex, verifyPassword } from '../crypto/hashing.js'
import { authGuard, isDeveloper, requireRole } from '../middleware/authGuard.js'
import { AppError } from '../middleware/errorHandler.js'
import { audit } from '../services/audit.js'
import { sendMail } from '../services/mailer.js'
import { DEFAULT_SETTINGS } from '../types/settings.js'
import { passwordPolicyProblem } from './commonPasswords.js'
import {
  issueRefreshToken,
  revokeAllForUser,
  revokeByRaw,
  rotateRefreshToken,
  uniqueSlug,
} from './service.js'
import {
  signAccessToken,
  signInviteToken,
  signResetToken,
  verifyInviteToken,
  verifyResetToken,
} from './tokens.js'

export const REFRESH_COOKIE = 'leadline_refresh'

const emailSchema = z.string().trim().toLowerCase().email().max(200)

const signupSchema = z
  .object({
    workspaceName: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    email: emailSchema,
    password: z.string(),
  })
  .strict()

const loginSchema = z.object({ email: emailSchema, password: z.string() }).strict()

const inviteSchema = z.object({ email: emailSchema, role: z.enum(['ADMIN', 'MEMBER']) }).strict()

const acceptInviteSchema = z
  .object({ token: z.string().min(1), name: z.string().trim().min(1).max(100), password: z.string() })
  .strict()

const changePasswordSchema = z
  .object({ currentPassword: z.string(), newPassword: z.string() })
  .strict()

const resetRequestSchema = z.object({ email: emailSchema }).strict()

const resetSchema = z.object({ token: z.string().min(1), newPassword: z.string() }).strict()

function publicUser(user: User, config: AppConfig) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    developer: isDeveloper(config, user.email),
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  }
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app
  const authLimit = {
    rateLimit: { max: config.authRateLimitMax, timeWindow: config.rateLimitWindowMs },
  }

  function setRefreshCookie(reply: FastifyReply, value: string): void {
    reply.setCookie(REFRESH_COOKIE, value, {
      path: '/api/v1/auth',
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite,
      domain: config.cookieDomain,
      maxAge: config.refreshTokenTtlSec,
    })
  }

  function clearRefreshCookie(reply: FastifyReply): void {
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth', domain: config.cookieDomain })
  }

  async function issueSession(reply: FastifyReply, user: User): Promise<string> {
    const { raw } = await issueRefreshToken(prisma, user.id, config)
    setRefreshCookie(reply, raw)
    return signAccessToken(user, config)
  }

  // ── Signup: one signup = one new workspace with its OWNER ─────────────────
  app.post('/signup', { config: authLimit }, async (request, reply) => {
    const body = signupSchema.parse(request.body)
    const policyProblem = passwordPolicyProblem(body.password, body.email)
    if (policyProblem) throw new AppError(400, policyProblem)

    const existing = await prisma.user.findUnique({ where: { email: body.email } })
    if (existing) throw new AppError(409, 'An account with this email already exists')

    const passwordHash = await hashPassword(body.password)
    const slug = await uniqueSlug(prisma, body.workspaceName)
    const { workspace, user } = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name: body.workspaceName, slug, settings: DEFAULT_SETTINGS as object },
      })
      const user = await tx.user.create({
        data: {
          workspaceId: workspace.id,
          email: body.email,
          name: body.name,
          passwordHash,
          role: 'OWNER',
          lastLoginAt: new Date(),
        },
      })
      return { workspace, user }
    })

    const accessToken = await issueSession(reply, user)
    await audit(prisma, { workspaceId: workspace.id, userId: user.id, action: 'auth.signup', target: user.email, ip: request.ip })
    return reply.status(201).send({
      accessToken,
      user: publicUser(user, config),
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, settings: workspace.settings },
    })
  })

  // ── Login ──────────────────────────────────────────────────────────────────
  app.post('/login', { config: authLimit }, async (request, reply) => {
    const body = loginSchema.parse(request.body)
    const user = await prisma.user.findUnique({ where: { email: body.email } })
    if (!user) {
      // Burn comparable time to a real verification to blunt timing probes.
      await hashPassword(body.password)
      throw new AppError(401, 'Invalid email or password')
    }
    const valid = await verifyPassword(user.passwordHash, body.password)
    if (!valid) {
      await audit(prisma, { workspaceId: user.workspaceId, userId: user.id, action: 'auth.login_failed', target: user.email, ip: request.ip })
      throw new AppError(401, 'Invalid email or password')
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    const accessToken = await issueSession(reply, user)
    await audit(prisma, { workspaceId: user.workspaceId, userId: user.id, action: 'auth.login', target: user.email, ip: request.ip })
    return { accessToken, user: publicUser(user, config) }
  })

  // ── Refresh: rotate the refresh token, detect reuse ────────────────────────
  app.post('/refresh', async (request, reply) => {
    const raw = request.cookies[REFRESH_COOKIE]
    if (!raw) throw new AppError(401, 'Missing refresh token')
    const result = await rotateRefreshToken(prisma, raw, config)
    if (!result.ok) {
      // A benign multi-tab race: another tab just rotated this token and its
      // replacement cookie is already in the jar — do NOT clear it.
      if (result.reason === 'raced') {
        throw new AppError(401, 'Refresh token was just rotated by a parallel request')
      }
      clearRefreshCookie(reply)
      if (result.reason === 'reused') {
        await audit(prisma, {
          workspaceId: result.user.workspaceId,
          userId: result.user.id,
          action: 'auth.refresh_reuse_detected',
          target: result.user.email,
          ip: request.ip,
        })
        throw new AppError(401, 'Refresh token reuse detected — all sessions revoked')
      }
      throw new AppError(401, 'Invalid or expired refresh token')
    }
    setRefreshCookie(reply, result.raw)
    return { accessToken: signAccessToken(result.user, config), user: publicUser(result.user, config) }
  })

  // ── Logout ─────────────────────────────────────────────────────────────────
  app.post('/logout', async (request, reply) => {
    const raw = request.cookies[REFRESH_COOKIE]
    if (raw) {
      const user = await revokeByRaw(prisma, raw)
      if (user) {
        await audit(prisma, { workspaceId: user.workspaceId, userId: user.id, action: 'auth.logout', target: user.email, ip: request.ip })
      }
    }
    clearRefreshCookie(reply)
    return { ok: true }
  })

  // ── Me ─────────────────────────────────────────────────────────────────────
  app.get('/me', { preHandler: [authGuard(app)] }, async (request) => {
    const auth = request.auth!
    const workspace = await prisma.workspace.findUnique({ where: { id: auth.workspaceId } })
    const user = await prisma.user.findUnique({ where: { id: auth.userId } })
    if (!workspace || !user) throw new AppError(401, 'Invalid access token')
    return {
      user: publicUser(user, config),
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, settings: workspace.settings },
    }
  })

  // ── Invites ────────────────────────────────────────────────────────────────
  app.post('/invite', { preHandler: [authGuard(app), requireRole('OWNER', 'ADMIN')] }, async (request) => {
    const auth = request.auth!
    const body = inviteSchema.parse(request.body)
    const existing = await prisma.user.findUnique({ where: { email: body.email } })
    if (existing) throw new AppError(409, 'A user with this email already exists')

    const token = signInviteToken({ workspaceId: auth.workspaceId, email: body.email, role: body.role }, config)
    const inviteUrl = `${config.corsOrigins[0] ?? ''}/accept-invite?token=${encodeURIComponent(token)}`
    const workspace = await prisma.workspace.findUnique({ where: { id: auth.workspaceId } })
    const emailed = await sendMail(config, {
      to: body.email,
      subject: `You've been invited to ${workspace?.name ?? 'Leadline'}`,
      text: `${auth.name} invited you to join ${workspace?.name ?? 'their workspace'} on Leadline as ${body.role}.\n\nAccept the invite:\n${inviteUrl}\n\nThis link expires in ${Math.round(config.inviteTokenTtlSec / 86400)} day(s).`,
    }).catch(() => false)
    await audit(prisma, { workspaceId: auth.workspaceId, userId: auth.userId, action: 'auth.invite_created', target: body.email, ip: request.ip })
    return { inviteUrl, token, emailed, expiresInSec: config.inviteTokenTtlSec }
  })

  app.post('/accept-invite', { config: authLimit }, async (request, reply) => {
    const body = acceptInviteSchema.parse(request.body)
    let claims
    try {
      claims = verifyInviteToken(body.token, config)
    } catch {
      throw new AppError(400, 'Invalid or expired invite token')
    }
    const policyProblem = passwordPolicyProblem(body.password, claims.email)
    if (policyProblem) throw new AppError(400, policyProblem)
    const existing = await prisma.user.findUnique({ where: { email: claims.email } })
    if (existing) throw new AppError(409, 'A user with this email already exists')
    const workspace = await prisma.workspace.findUnique({ where: { id: claims.workspaceId } })
    if (!workspace) throw new AppError(400, 'Workspace no longer exists')

    const user = await prisma.user.create({
      data: {
        workspaceId: claims.workspaceId,
        email: claims.email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        role: claims.role,
        lastLoginAt: new Date(),
      },
    })
    const accessToken = await issueSession(reply, user)
    await audit(prisma, { workspaceId: workspace.id, userId: user.id, action: 'auth.invite_accepted', target: user.email, ip: request.ip })
    return reply.status(201).send({
      accessToken,
      user: publicUser(user, config),
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, settings: workspace.settings },
    })
  })

  // ── Password change / reset ────────────────────────────────────────────────
  app.post('/password/change', { preHandler: [authGuard(app)] }, async (request, reply) => {
    const auth = request.auth!
    const body = changePasswordSchema.parse(request.body)
    const user = await prisma.user.findUnique({ where: { id: auth.userId } })
    if (!user || !(await verifyPassword(user.passwordHash, body.currentPassword))) {
      throw new AppError(401, 'Current password is incorrect')
    }
    const policyProblem = passwordPolicyProblem(body.newPassword, user.email)
    if (policyProblem) throw new AppError(400, policyProblem)
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } })
    // Kill every existing session, then start a fresh one for this client.
    await revokeAllForUser(prisma, user.id)
    const accessToken = await issueSession(reply, user)
    await audit(prisma, { workspaceId: user.workspaceId, userId: user.id, action: 'auth.password_changed', target: user.email, ip: request.ip })
    return { ok: true, accessToken }
  })

  app.post('/password/reset-request', { config: authLimit }, async (request) => {
    const body = resetRequestSchema.parse(request.body)
    const user = await prisma.user.findUnique({ where: { email: body.email } })
    if (user) {
      const token = signResetToken(user, config)
      const resetUrl = `${config.corsOrigins[0] ?? ''}/reset-password?token=${encodeURIComponent(token)}`
      const emailed = await sendMail(config, {
        to: user.email,
        subject: 'Reset your Leadline password',
        text: `A password reset was requested for this address.\n\nReset your password:\n${resetUrl}\n\nThis link expires in ${Math.round(config.resetTokenTtlSec / 60)} minute(s). If you did not request this, ignore this email.`,
      }).catch(() => false)
      if (!emailed) {
        // No SMTP configured: surface the link to the operator via server logs only.
        request.log.info({ userId: user.id, resetUrl }, 'password reset requested (SMTP not configured — deliver this link manually)')
      }
      await audit(prisma, { workspaceId: user.workspaceId, userId: user.id, action: 'auth.password_reset_requested', target: user.email, ip: request.ip })
    }
    // Always 200 with the same body to prevent user enumeration.
    return { ok: true }
  })

  app.post('/password/reset', { config: authLimit }, async (request) => {
    const body = resetSchema.parse(request.body)
    let claims
    try {
      claims = verifyResetToken(body.token, config)
    } catch {
      throw new AppError(400, 'Invalid or expired reset token')
    }
    const user = await prisma.user.findUnique({ where: { id: claims.userId } })
    if (!user) throw new AppError(400, 'Invalid or expired reset token')
    if (sha256Hex(user.passwordHash).slice(0, 16) !== claims.pwv) {
      throw new AppError(400, 'Invalid or expired reset token')
    }
    const policyProblem = passwordPolicyProblem(body.newPassword, user.email)
    if (policyProblem) throw new AppError(400, policyProblem)
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } })
    await revokeAllForUser(prisma, user.id)
    await audit(prisma, { workspaceId: user.workspaceId, userId: user.id, action: 'auth.password_reset', target: user.email, ip: request.ip })
    return { ok: true }
  })
}
