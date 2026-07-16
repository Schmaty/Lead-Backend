import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { decryptSecret, encryptSecret, maskSecret } from '../../crypto/secrets.js'
import { authGuard, requireDeveloper } from '../../middleware/authGuard.js'
import { AppError } from '../../middleware/errorHandler.js'
import { audit } from '../../services/audit.js'
import { PLATFORM_CREDENTIAL_KINDS } from '../../services/platformCredentials.js'

const kindSchema = z.enum(PLATFORM_CREDENTIAL_KINDS)

const putSchema = z
  .object({
    value: z.string().min(1).max(20_000),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

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

  app.put('/credentials/:kind', { preHandler: [guard, developerOnly] }, async (request) => {
    const auth = request.auth!
    const kind = kindSchema.parse((request.params as { kind: string }).kind)
    const body = putSchema.parse(request.body)
    if (kind === 'GOOGLE_OAUTH_CLIENT' && typeof body.meta?.clientId !== 'string') {
      throw new AppError(400, 'GOOGLE_OAUTH_CLIENT requires meta.clientId (value is the client secret)')
    }
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
