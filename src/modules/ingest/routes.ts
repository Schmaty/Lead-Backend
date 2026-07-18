import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sha256Hex } from '../../crypto/hashing.js'
import { apiKeyGuard } from '../../middleware/apiKeyGuard.js'
import { upsertLeadByExternalId } from '../../services/leadUpsert.js'
import { resolveSettings } from '../../types/settings.js'
import { isoDate } from '../leads/schemas.js'
import { normalizeStage } from '../pipeline/stages.js'

const score = z.number().int().min(0).max(10)

/** Payload contract for the ingest webhook (external pipelines / scripts). */
export const ingestLeadSchema = z.object({
  externalId: z.string().trim().min(1).max(300),
  receivedAt: isoDate,
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  org: z.string().max(300).default(''),
  source: z.string().trim().min(1).max(100),
  inquiryType: z.string().trim().min(1).max(150),
  summary: z.string().max(10_000).default(''),
  fitScore: score,
  urgencyScore: score,
  leadScore: score,
  dealValueLow: z.number().min(0).default(0),
  dealValueHigh: z.number().min(0).default(0),
  estPayoutRaw: z.string().max(1000).default(''),
  estWork: z.string().max(1000).default(''),
  recommendedNextStep: z.string().max(5000).default(''),
  /** Optional: where the deal already sits. Clamped to the workspace's stages; defaults to the first stage. */
  stage: z.string().trim().max(150).optional(),
  draftReply: z.string().max(50_000).default(''),
  fitReasons: z.array(z.string().max(1000)).max(100).default([]),
  riskFlags: z.array(z.string().max(1000)).max(100).default([]),
  inferredFields: z.array(z.string().max(200)).max(100).default([]),
  threads: z
    .array(
      z.object({
        subject: z.string().max(500),
        url: z.string().max(2000),
        direction: z.enum(['in', 'out']),
        date: isoDate,
        snippet: z.string().max(5000),
      }),
    )
    .max(200)
    .default([]),
})

export default async function ingestRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app

  app.post(
    '/leads',
    {
      preHandler: [apiKeyGuard(app)],
      config: {
        rateLimit: {
          max: config.ingestRateLimitMax,
          timeWindow: config.rateLimitWindowMs,
          keyGenerator: (request: { headers: Record<string, unknown>; ip: string }) => {
            const key = request.headers['x-api-key']
            return typeof key === 'string' ? `ingest:${sha256Hex(key)}` : request.ip
          },
        },
      },
    },
    async (request, reply) => {
      const wsId = request.ingest!.workspaceId
      const payload = ingestLeadSchema.parse(request.body)

      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: wsId } })
      const settings = resolveSettings(workspace.settings)

      const initialStage = normalizeStage(payload.stage, settings)
      const result = await upsertLeadByExternalId(prisma, wsId, settings, {
        ...payload,
        initialStage,
        createdDetail:
          initialStage === settings.stages[0]
            ? `Ingested via webhook (${payload.source})`
            : `Ingested via webhook (${payload.source}) · stage ${initialStage}`,
      })
      return reply.status(result.created ? 201 : 200).send({ id: result.lead.id, created: result.created })
    },
  )
}
