import { createHmac } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { sha256Hex, timingSafeEqualStr } from '../crypto/hashing.js'
import { decryptSecret } from '../crypto/secrets.js'
import { AppError } from './errorHandler.js'

/**
 * preHandler for the ingest webhook: authenticates by `x-api-key`, resolves the
 * workspace, and (when enabled + configured) verifies an HMAC-SHA256 signature
 * of the raw request body against the workspace's N8N_WEBHOOK secret.
 */
export function apiKeyGuard(app: FastifyInstance) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const rawKey = request.headers['x-api-key']
    if (typeof rawKey !== 'string' || rawKey.length === 0) {
      throw new AppError(401, 'Missing x-api-key header')
    }
    const apiKey = await app.prisma.apiKey.findUnique({ where: { keyHash: sha256Hex(rawKey) } })
    if (!apiKey || apiKey.revokedAt) {
      throw new AppError(401, 'Invalid API key')
    }
    const scopes = apiKey.scopes
    if (!Array.isArray(scopes) || !scopes.includes('ingest')) {
      throw new AppError(403, 'API key lacks the ingest scope')
    }

    if (app.config.ingestHmacEnabled) {
      const credential = await app.prisma.credential.findUnique({
        where: { workspaceId_kind: { workspaceId: apiKey.workspaceId, kind: 'N8N_WEBHOOK' } },
      })
      if (credential) {
        const secret = decryptSecret(credential.encryptedValue, app.config.encryptionKey)
        const signature = request.headers['x-signature']
        const expected = createHmac('sha256', secret)
          .update(request.rawBody ?? Buffer.alloc(0))
          .digest('hex')
        if (typeof signature !== 'string' || !timingSafeEqualStr(signature.toLowerCase(), expected)) {
          throw new AppError(401, 'Invalid or missing x-signature')
        }
      }
    }

    await app.prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    request.ingest = { workspaceId: apiKey.workspaceId, apiKeyId: apiKey.id }
  }
}
