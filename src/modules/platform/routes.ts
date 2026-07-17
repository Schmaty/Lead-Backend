import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { decryptSecret, encryptSecret, maskSecret } from '../../crypto/secrets.js'
import { authGuard, requireDeveloper } from '../../middleware/authGuard.js'
import { AppError } from '../../middleware/errorHandler.js'
import { audit } from '../../services/audit.js'
import { PLATFORM_CREDENTIAL_KINDS, SCORER_MODELS } from '../../services/platformCredentials.js'

const kindSchema = z.enum(PLATFORM_CREDENTIAL_KINDS)

const putSchema = z
  .object({
    value: z.string().min(1).max(20_000),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const metaPatchSchema = z.object({ meta: z.record(z.string(), z.unknown()) }).strict()

function validateMeta(kind: string, meta: Record<string, unknown> | undefined): void {
  if (kind === 'GOOGLE_OAUTH_CLIENT' && typeof meta?.clientId !== 'string') {
    throw new AppError(400, 'GOOGLE_OAUTH_CLIENT requires meta.clientId (value is the client secret)')
  }
  if (kind === 'ZOHO_CRM' && typeof meta?.clientId !== 'string') {
    throw new AppError(400, 'ZOHO_CRM requires meta.clientId (value is JSON {"clientSecret","refreshToken"})')
  }
  if (kind === 'ANTHROPIC_API_KEY' && meta?.model !== undefined && !(SCORER_MODELS as readonly string[]).includes(String(meta.model))) {
    throw new AppError(400, `model must be one of: ${SCORER_MODELS.join(', ')}`)
  }
}

/**
 * Platform credentials — the universal secrets every workspace runs on,
 * locked to the developer allowlist (DEVELOPER_EMAILS). Clients never see
 * or manage these; they just sign in.
 */
export default async function platformRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app
  const guard = authGuard(app)
  const developerOnly = requireDeveloper(app)

  app.get('/credentials', { preHandler: [guard, developerOnly] }, async () => {
    const credentials = await prisma.platformCredential.findMany({ orderBy: { kind: 'asc' } })
    return {
      credentials: credentials.map((credential) => {
        let maskedValue = '(unreadable)'
        try {
          const raw = decryptSecret(credential.encryptedValue, config.encryptionKey)
          // ZOHO_CRM stores a JSON blob {clientSecret, refreshToken} — masking
          // that verbatim reads as gibberish, so show a clean "connected" label.
          maskedValue = credential.kind === 'ZOHO_CRM' ? '•••••••• connected' : maskSecret(raw)
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

  app.put('/credentials/:kind', { preHandler: [guard, developerOnly] }, async (request) => {
    const auth = request.auth!
    const kind = kindSchema.parse((request.params as { kind: string }).kind)
    const body = putSchema.parse(request.body)
    validateMeta(kind, body.meta)
    const encryptedValue = encryptSecret(body.value, config.encryptionKey)
    const credential = await prisma.platformCredential.upsert({
      where: { kind },
      create: { kind, encryptedValue, meta: (body.meta ?? {}) as Prisma.InputJsonValue },
      update: {
        encryptedValue,
        ...(body.meta !== undefined ? { meta: body.meta as Prisma.InputJsonValue } : {}),
      },
    })
    await audit(prisma, {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      action: 'platform.credential_set',
      target: kind,
      ip: request.ip,
    })
    return {
      kind: credential.kind,
      maskedValue: maskSecret(body.value),
      meta: credential.meta,
      updatedAt: credential.updatedAt,
    }
  })

  /**
   * Update only a credential's meta (e.g. the scorer model on
   * ANTHROPIC_API_KEY) without re-pasting the secret. Merge semantics.
   */
  app.patch('/credentials/:kind', { preHandler: [guard, developerOnly] }, async (request) => {
    const auth = request.auth!
    const kind = kindSchema.parse((request.params as { kind: string }).kind)
    const { meta } = metaPatchSchema.parse(request.body)
    const existing = await prisma.platformCredential.findUnique({ where: { kind } })
    if (!existing) throw new AppError(404, 'Credential not found — store the secret first')
    const merged = { ...(existing.meta as Record<string, unknown>), ...meta }
    validateMeta(kind, merged)
    const credential = await prisma.platformCredential.update({
      where: { kind },
      data: { meta: merged as Prisma.InputJsonValue },
    })
    await audit(prisma, {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      action: 'platform.credential_meta_updated',
      target: `${kind}:${Object.keys(meta).join(',')}`,
      ip: request.ip,
    })
    return { kind: credential.kind, meta: credential.meta, updatedAt: credential.updatedAt }
  })

  app.delete('/credentials/:kind', { preHandler: [guard, developerOnly] }, async (request) => {
    const auth = request.auth!
    const kind = kindSchema.parse((request.params as { kind: string }).kind)
    const result = await prisma.platformCredential.deleteMany({ where: { kind } })
    if (result.count === 0) throw new AppError(404, 'Credential not found')
    await audit(prisma, {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      action: 'platform.credential_deleted',
      target: kind,
      ip: request.ip,
    })
    return { ok: true }
  })
}
