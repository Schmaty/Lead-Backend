import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { encryptSecret } from '../../crypto/secrets.js'
import { authGuard, requireRole } from '../../middleware/authGuard.js'
import { AppError } from '../../middleware/errorHandler.js'
import { workspaceId } from '../../middleware/workspaceScope.js'
import { audit } from '../../services/audit.js'
import { getGoogleOauthClient, getMicrosoftOauthClient } from '../../services/platformCredentials.js'
import { resolveSettings } from '../../types/settings.js'
import {
  signGmailConnectToken,
  verifyGmailConnectToken,
  signMicrosoftConnectToken,
  verifyMicrosoftConnectToken,
} from '../../auth/tokens.js'
import { buildGoogleAuthUrl, googleOauth, googleRedirectUri } from './googleOauth.js'
import { buildMicrosoftAuthUrl, microsoftOauth, microsoftRedirectUri } from './microsoftOauth.js'
import { getScanState, GMAIL_OAUTH_KIND, MICROSOFT_OAUTH_KIND, resolveScanSetup, runScan } from './scanner.js'

/** Inbox-scanning pipeline: connect, trigger, status. Registered under /workspace. */
export default async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app
  const guard = authGuard(app)
  const adminOnly = requireRole('OWNER', 'ADMIN')

  // ── Start the Google sign-in that connects this workspace's inbox ────────
  app.post('/gmail/connect', { preHandler: [guard, adminOnly] }, async (request) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const client = await getGoogleOauthClient(prisma, config)
    if (!client) {
      throw new AppError(400, 'Google sign-in is not set up yet — the developer needs to add the platform Google OAuth client')
    }
    const state = signGmailConnectToken({ workspaceId: wsId, userId: auth.userId }, config)
    return {
      url: buildGoogleAuthUrl({
        clientId: client.clientId,
        redirectUri: googleRedirectUri(config.publicUrl),
        state,
      }),
    }
  })

  // ── Start the Microsoft 365 sign-in that connects this workspace's inbox ──
  app.post('/microsoft/connect', { preHandler: [guard, adminOnly] }, async (request) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const client = await getMicrosoftOauthClient(prisma, config)
    if (!client) {
      throw new AppError(400, 'Microsoft sign-in is not set up yet — the developer needs to add the platform Microsoft OAuth client')
    }
    const state = signMicrosoftConnectToken({ workspaceId: wsId, userId: auth.userId }, config)
    return {
      url: buildMicrosoftAuthUrl({
        clientId: client.clientId,
        tenant: client.tenant,
        redirectUri: microsoftRedirectUri(config.publicUrl),
        state,
      }),
    }
  })

  // ── Kick off a scan now (runs in the background; poll status) ────────────
  app.post('/scan', { preHandler: [guard, adminOnly] }, async (request, reply) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const state = getScanState(wsId)
    if (state.running) throw new AppError(409, 'A scan is already running for this workspace')
    const { credentials } = await resolveScanSetup(prisma, config, wsId)
    if (!credentials) {
      throw new AppError(
        400,
        'Inbox scanning is not configured — connect the Gmail inbox, and make sure the platform AI key is set',
      )
    }
    void runScan(prisma, config, wsId).catch((err) => {
      app.log.error({ err, workspaceId: wsId }, 'inbox scan failed')
    })
    await audit(prisma, { workspaceId: wsId, userId: auth.userId, action: 'pipeline.scan_started', target: 'inbox', ip: request.ip })
    return reply.status(202).send({ started: true })
  })

  // ── One-shot import: 90 days of email + meetings + Zoho's open leads ─────
  app.post('/import', { preHandler: [guard, adminOnly] }, async (request, reply) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const state = getScanState(wsId)
    if (state.running) throw new AppError(409, 'A scan is already running for this workspace')
    const { credentials } = await resolveScanSetup(prisma, config, wsId)
    if (!credentials) {
      throw new AppError(
        400,
        'Inbox scanning is not configured — connect the Gmail inbox, and make sure the platform AI key is set',
      )
    }
    void runScan(prisma, config, wsId, undefined, { deep: true }).catch((err) => {
      app.log.error({ err, workspaceId: wsId }, 'import failed')
    })
    await audit(prisma, { workspaceId: wsId, userId: auth.userId, action: 'pipeline.import_started', target: 'history', ip: request.ip })
    return reply.status(202).send({ started: true })
  })

  // ── Scan status (any signed-in member) ───────────────────────────────────
  app.get('/scan/status', { preHandler: [guard] }, async (request) => {
    const wsId = workspaceId(request)
    const [{ info }, workspace] = await Promise.all([
      resolveScanSetup(prisma, config, wsId),
      prisma.workspace.findUniqueOrThrow({ where: { id: wsId } }),
    ])
    const state = getScanState(wsId)
    return {
      configured: info.configured,
      method: info.method,
      provider: info.provider,
      email: info.email,
      googleSignInAvailable: info.googleSignInAvailable,
      microsoftSignInAvailable: info.microsoftSignInAvailable,
      aiReady: info.aiReady,
      running: state.running,
      progress: state.running ? (state.progress ?? null) : null,
      lastScanAt: info.lastScanAt,
      pollMinutes: resolveSettings(workspace.settings).scanSettings.pollMinutes,
      lastResult: state.lastResult ?? null,
      lastError: state.lastError ?? null,
    }
  })
}

/**
 * Google OAuth callback — public (Google redirects the client's browser here;
 * the signed state token is what ties it back to a workspace). Registered
 * under /api/v1/auth.
 */
export async function googleCallbackRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app

  app.get('/google/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string }
    const back = (outcome: string): never => {
      void reply.redirect(`${config.publicUrl}/#/settings?email=${outcome}`)
      return undefined as never
    }

    if (query.error) return back('error')
    if (!query.code || !query.state) return back('error')

    let claims
    try {
      claims = verifyGmailConnectToken(query.state, config)
    } catch {
      return back('error')
    }

    const client = await getGoogleOauthClient(prisma, config)
    if (!client) return back('error')

    let exchange
    try {
      exchange = await googleOauth.exchangeCode({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code: query.code,
        redirectUri: googleRedirectUri(config.publicUrl),
      })
    } catch (err) {
      app.log.error({ err }, 'google code exchange failed')
      return back('error')
    }
    if (!exchange.refreshToken || !exchange.email) return back('error')

    // Reconnecting the same mailbox keeps its scan cursor; a new mailbox starts fresh.
    const existing = await prisma.credential.findUnique({
      where: { workspaceId_kind: { workspaceId: claims.workspaceId, kind: GMAIL_OAUTH_KIND } },
    })
    const existingMeta = (existing?.meta ?? {}) as { email?: string; lastScanAt?: string }
    const meta = {
      email: exchange.email,
      ...(existingMeta.email === exchange.email && existingMeta.lastScanAt
        ? { lastScanAt: existingMeta.lastScanAt }
        : {}),
    }
    const encryptedValue = encryptSecret(exchange.refreshToken, config.encryptionKey)
    await prisma.credential.upsert({
      where: { workspaceId_kind: { workspaceId: claims.workspaceId, kind: GMAIL_OAUTH_KIND } },
      create: { workspaceId: claims.workspaceId, kind: GMAIL_OAUTH_KIND, encryptedValue, meta: meta as Prisma.InputJsonValue },
      update: { encryptedValue, meta: meta as Prisma.InputJsonValue },
    })
    // One connected mailbox per workspace: switching from Outlook clears it.
    await prisma.credential.deleteMany({ where: { workspaceId: claims.workspaceId, kind: MICROSOFT_OAUTH_KIND } })
    await audit(prisma, {
      workspaceId: claims.workspaceId,
      userId: claims.userId,
      action: 'gmail.connected',
      target: exchange.email,
      ip: request.ip,
    })
    return back('connected')
  })
}

/**
 * Microsoft 365 / Outlook OAuth callback — public (Microsoft redirects the
 * client's browser here; the signed state token ties it back to a workspace).
 * Registered under /api/v1/auth. Mirror of the Google callback.
 */
export async function microsoftCallbackRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app

  app.get('/microsoft/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string }
    const back = (outcome: string): never => {
      void reply.redirect(`${config.publicUrl}/#/settings?email=${outcome}`)
      return undefined as never
    }

    if (query.error) return back('error')
    if (!query.code || !query.state) return back('error')

    let claims
    try {
      claims = verifyMicrosoftConnectToken(query.state, config)
    } catch {
      return back('error')
    }

    const client = await getMicrosoftOauthClient(prisma, config)
    if (!client) return back('error')

    let exchange
    try {
      exchange = await microsoftOauth.exchangeCode({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        tenant: client.tenant,
        code: query.code,
        redirectUri: microsoftRedirectUri(config.publicUrl),
      })
    } catch (err) {
      app.log.error({ err }, 'microsoft code exchange failed')
      return back('error')
    }
    if (!exchange.refreshToken || !exchange.email) return back('error')

    // Reconnecting the same mailbox keeps its scan cursor; a new mailbox starts fresh.
    const existing = await prisma.credential.findUnique({
      where: { workspaceId_kind: { workspaceId: claims.workspaceId, kind: MICROSOFT_OAUTH_KIND } },
    })
    const existingMeta = (existing?.meta ?? {}) as { email?: string; lastScanAt?: string }
    const meta = {
      email: exchange.email,
      ...(existingMeta.email === exchange.email && existingMeta.lastScanAt
        ? { lastScanAt: existingMeta.lastScanAt }
        : {}),
    }
    const encryptedValue = encryptSecret(exchange.refreshToken, config.encryptionKey)
    await prisma.credential.upsert({
      where: { workspaceId_kind: { workspaceId: claims.workspaceId, kind: MICROSOFT_OAUTH_KIND } },
      create: { workspaceId: claims.workspaceId, kind: MICROSOFT_OAUTH_KIND, encryptedValue, meta: meta as Prisma.InputJsonValue },
      update: { encryptedValue, meta: meta as Prisma.InputJsonValue },
    })
    // One connected mailbox per workspace: switching from Gmail clears it.
    await prisma.credential.deleteMany({ where: { workspaceId: claims.workspaceId, kind: GMAIL_OAUTH_KIND } })
    await audit(prisma, {
      workspaceId: claims.workspaceId,
      userId: claims.userId,
      action: 'microsoft.connected',
      target: exchange.email,
      ip: request.ip,
    })
    return back('connected')
  })
}
