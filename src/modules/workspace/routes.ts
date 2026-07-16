import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { generateApiKey } from '../../crypto/hashing.js'
import { decryptSecret, encryptSecret, maskSecret } from '../../crypto/secrets.js'
import { authGuard, requireRole } from '../../middleware/authGuard.js'
import { AppError } from '../../middleware/errorHandler.js'
import { workspaceId } from '../../middleware/workspaceScope.js'
import { audit } from '../../services/audit.js'
import { applyComputed } from '../../services/leadCompute.js'
import { resolveSettings, type WorkspaceSettings } from '../../types/settings.js'

export const CREDENTIAL_KINDS = ['ANTHROPIC_API_KEY', 'GMAIL_OAUTH', 'N8N_WEBHOOK', 'GOOGLE_SHEET'] as const

const credentialKindSchema = z.enum(CREDENTIAL_KINDS)

const credentialPutSchema = z
  .object({
    value: z.string().min(1).max(20_000),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const apiKeyCreateSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict()

const settingsPatchSchema = z
  .object({
    tierThresholds: z
      .object({ hot: z.number().int().min(0).max(10), warm: z.number().int().min(0).max(10) })
      .refine((t) => t.warm <= t.hot, 'warm threshold must be <= hot threshold')
      .optional(),
    winProbabilityMap: z
      .array(z.object({ min: z.number().min(0).max(10), p: z.number().min(0).max(1) }))
      .min(1)
      .max(20)
      .optional(),
    stages: z.array(z.string().trim().min(1).max(60)).min(1).max(30).optional(),
    closedStages: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    wonStage: z.string().trim().min(1).max(60).optional(),
    lostStage: z.string().trim().min(1).max(60).optional(),
    sources: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    inquiryTypes: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    notificationThresholds: z.object({ hotLeadScore: z.number().int().min(0).max(10) }).optional(),
    scanSettings: z.object({ pollMinutes: z.number().int().min(1).max(1440) }).optional(),
    staleDays: z.number().int().min(1).max(365).optional(),
    /**
     * Rename existing stages. Applied before the rest of the patch: updates
     * the stage lists AND every lead carrying the old name (no timeline noise).
     */
    stageRenames: z
      .array(z.object({ from: z.string().trim().min(1).max(60), to: z.string().trim().min(1).max(60) }))
      .max(30)
      .optional(),
  })
  .strict()

export default async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app
  const guard = authGuard(app)
  const adminOnly = requireRole('OWNER', 'ADMIN')

  // ── Workspace + settings ───────────────────────────────────────────────────
  app.get('/', { preHandler: [guard] }, async (request) => {
    const wsId = workspaceId(request)
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: wsId },
      include: { users: { orderBy: { createdAt: 'asc' } } },
    })
    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt,
      settings: resolveSettings(workspace.settings),
      users: workspace.users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        lastLoginAt: user.lastLoginAt,
      })),
    }
  })

  app.get('/users', { preHandler: [guard] }, async (request) => {
    const wsId = workspaceId(request)
    const users = await prisma.user.findMany({ where: { workspaceId: wsId }, orderBy: { createdAt: 'asc' } })
    return {
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        lastLoginAt: user.lastLoginAt,
      })),
    }
  })

  app.patch('/settings', { preHandler: [guard, adminOnly] }, async (request) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const { stageRenames, ...rest } = settingsPatchSchema.parse(request.body)
    const provided = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined))
    const renames = (stageRenames ?? []).filter((r) => r.from !== r.to)
    if (Object.keys(provided).length === 0 && renames.length === 0) {
      throw new AppError(400, 'No settings provided')
    }

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: wsId } })
    let current = resolveSettings(workspace.settings)
    for (const { from, to } of renames) {
      if (!current.stages.includes(from)) {
        throw new AppError(400, `Cannot rename unknown stage "${from}"`)
      }
      if (current.stages.includes(to)) {
        throw new AppError(400, `Stage "${to}" already exists`)
      }
      current = {
        ...current,
        stages: current.stages.map((s) => (s === from ? to : s)),
        closedStages: current.closedStages.map((s) => (s === from ? to : s)),
        wonStage: current.wonStage === from ? to : current.wonStage,
        lostStage: current.lostStage === from ? to : current.lostStage,
      }
    }
    const merged: WorkspaceSettings = { ...current, ...provided }

    if (!merged.stages.includes(merged.wonStage)) {
      throw new AppError(400, `wonStage "${merged.wonStage}" must be one of stages`)
    }
    if (!merged.stages.includes(merged.lostStage)) {
      throw new AppError(400, `lostStage "${merged.lostStage}" must be one of stages`)
    }
    const orphanClosed = merged.closedStages.filter((stage) => !merged.stages.includes(stage))
    if (orphanClosed.length > 0) {
      throw new AppError(400, 'closedStages must be a subset of stages', { unknownStages: orphanClosed })
    }

    await prisma.$transaction([
      ...renames.map(({ from, to }) =>
        prisma.lead.updateMany({ where: { workspaceId: wsId, stage: from }, data: { stage: to } }),
      ),
      prisma.workspace.update({ where: { id: wsId }, data: { settings: merged as object } }),
    ])

    // Thresholds or the probability map changed → recompute derived lead fields.
    let recomputedLeads = 0
    if (provided.tierThresholds !== undefined || provided.winProbabilityMap !== undefined) {
      recomputedLeads = await recomputeWorkspaceLeads(prisma, wsId, merged)
    }
    await audit(prisma, {
      workspaceId: wsId,
      userId: auth.userId,
      action: 'workspace.settings_updated',
      target: [...Object.keys(provided), ...(renames.length ? ['stageRenames'] : [])].join(','),
      ip: request.ip,
    })
    return { settings: merged, recomputedLeads, renamedStages: renames.length }
  })

  // ── Integration credentials (encrypted at rest, returned masked) ──────────
  app.get('/credentials', { preHandler: [guard, adminOnly] }, async (request) => {
    const wsId = workspaceId(request)
    const credentials = await prisma.credential.findMany({
      where: { workspaceId: wsId },
      orderBy: { kind: 'asc' },
    })
    return {
      credentials: credentials.map((credential) => {
        let maskedValue = '(unreadable)'
        try {
          maskedValue = maskSecret(decryptSecret(credential.encryptedValue, config.encryptionKey))
        } catch {
          /* wrong key or corrupted blob — never leak details */
        }
        return {
          kind: credential.kind,
          maskedValue,
          meta: credential.meta,
          createdAt: credential.createdAt,
          updatedAt: credential.updatedAt,
        }
      }),
    }
  })

  app.put('/credentials/:kind', { preHandler: [guard, adminOnly] }, async (request) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const kind = credentialKindSchema.parse((request.params as { kind: string }).kind)
    const body = credentialPutSchema.parse(request.body)
    const encryptedValue = encryptSecret(body.value, config.encryptionKey)
    const credential = await prisma.credential.upsert({
      where: { workspaceId_kind: { workspaceId: wsId, kind } },
      create: { workspaceId: wsId, kind, encryptedValue, meta: (body.meta ?? {}) as Prisma.InputJsonValue },
      update: {
        encryptedValue,
        ...(body.meta !== undefined ? { meta: body.meta as Prisma.InputJsonValue } : {}),
      },
    })
    await audit(prisma, { workspaceId: wsId, userId: auth.userId, action: 'credential.set', target: kind, ip: request.ip })
    return {
      kind: credential.kind,
      maskedValue: maskSecret(body.value),
      meta: credential.meta,
      updatedAt: credential.updatedAt,
    }
  })

  app.delete('/credentials/:kind', { preHandler: [guard, adminOnly] }, async (request) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const kind = credentialKindSchema.parse((request.params as { kind: string }).kind)
    const result = await prisma.credential.deleteMany({ where: { workspaceId: wsId, kind } })
    if (result.count === 0) throw new AppError(404, 'Credential not found')
    await audit(prisma, { workspaceId: wsId, userId: auth.userId, action: 'credential.deleted', target: kind, ip: request.ip })
    return { ok: true }
  })

  // ── Ingest API keys ────────────────────────────────────────────────────────
  app.get('/api-keys', { preHandler: [guard, adminOnly] }, async (request) => {
    const wsId = workspaceId(request)
    const keys = await prisma.apiKey.findMany({ where: { workspaceId: wsId }, orderBy: { createdAt: 'desc' } })
    return {
      apiKeys: keys.map((key) => ({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        scopes: key.scopes,
        lastUsedAt: key.lastUsedAt,
        revokedAt: key.revokedAt,
        createdAt: key.createdAt,
      })),
    }
  })

  app.post('/api-keys', { preHandler: [guard, adminOnly] }, async (request, reply) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const body = apiKeyCreateSchema.parse(request.body)
    const { key, prefix, keyHash } = generateApiKey()
    const created = await prisma.apiKey.create({
      data: { workspaceId: wsId, name: body.name, prefix, keyHash },
    })
    await audit(prisma, { workspaceId: wsId, userId: auth.userId, action: 'apikey.created', target: `${body.name} (${prefix}…)`, ip: request.ip })
    return reply.status(201).send({
      id: created.id,
      name: created.name,
      prefix: created.prefix,
      key,
      warning: 'Store this key now — it is shown only once and cannot be recovered.',
    })
  })

  app.delete('/api-keys/:id', { preHandler: [guard, adminOnly] }, async (request) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const { id } = request.params as { id: string }
    const key = await prisma.apiKey.findFirst({ where: { id, workspaceId: wsId } })
    if (!key) throw new AppError(404, 'API key not found')
    if (!key.revokedAt) {
      await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } })
    }
    await audit(prisma, { workspaceId: wsId, userId: auth.userId, action: 'apikey.revoked', target: `${key.name} (${key.prefix}…)`, ip: request.ip })
    return { ok: true }
  })
}

type PrismaLike = FastifyInstance['prisma']

async function recomputeWorkspaceLeads(
  prisma: PrismaLike,
  wsId: string,
  settings: WorkspaceSettings,
): Promise<number> {
  const leads = await prisma.lead.findMany({
    where: { workspaceId: wsId, deletedAt: null },
    select: {
      id: true,
      leadScore: true,
      dealValueLow: true,
      dealValueHigh: true,
      tier: true,
      winProbability: true,
      winProbabilityOverridden: true,
      expectedValue: true,
    },
  })
  const updates = leads
    .map((lead) => ({ id: lead.id, current: lead, next: applyComputed(lead, settings) }))
    .filter(
      ({ current, next }) =>
        current.tier !== next.tier ||
        current.winProbability !== next.winProbability ||
        current.expectedValue !== next.expectedValue,
    )
  const CHUNK = 50
  for (let i = 0; i < updates.length; i += CHUNK) {
    await prisma.$transaction(
      updates.slice(i, i + CHUNK).map(({ id, next }) =>
        prisma.lead.update({
          where: { id },
          data: { tier: next.tier, winProbability: next.winProbability, expectedValue: next.expectedValue },
        }),
      ),
    )
  }
  return updates.length
}
