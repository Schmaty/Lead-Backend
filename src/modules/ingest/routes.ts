import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { sha256Hex } from '../../crypto/hashing.js'
import { apiKeyGuard } from '../../middleware/apiKeyGuard.js'
import { applyComputed } from '../../services/leadCompute.js'
import { resolveSettings } from '../../types/settings.js'
import { isoDate } from '../leads/schemas.js'

const score = z.number().int().min(0).max(10)

/** Payload contract for the n8n "Finalize Row" → HTTP Request node (§8). */
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

      const aiFields = {
        receivedAt: payload.receivedAt,
        name: payload.name,
        email: payload.email,
        org: payload.org,
        source: payload.source,
        inquiryType: payload.inquiryType,
        summary: payload.summary,
        fitScore: payload.fitScore,
        urgencyScore: payload.urgencyScore,
        leadScore: payload.leadScore,
        dealValueLow: payload.dealValueLow,
        dealValueHigh: payload.dealValueHigh,
        estPayoutRaw: payload.estPayoutRaw,
        estWork: payload.estWork,
        recommendedNextStep: payload.recommendedNextStep,
        draftReply: payload.draftReply,
        fitReasons: payload.fitReasons,
        riskFlags: payload.riskFlags,
        inferredFields: payload.inferredFields,
      }
      const threadRows = payload.threads.map((thread) => ({
        subject: thread.subject,
        url: thread.url,
        direction: thread.direction,
        date: thread.date,
        snippet: thread.snippet,
      }))

      /** Upsert by (workspaceId, externalId): re-runs update, never duplicate. */
      const upsertOnce = () =>
        prisma.$transaction(async (tx) => {
          const existing = await tx.lead.findUnique({
            where: { workspaceId_externalId: { workspaceId: wsId, externalId: payload.externalId } },
          })
          if (!existing) {
            const computed = applyComputed(payload, settings)
            const lead = await tx.lead.create({
              data: {
                workspaceId: wsId,
                externalId: payload.externalId,
                ...aiFields,
                ...computed,
                stage: 'New',
                lastTouchedAt: payload.receivedAt,
                threads: { create: threadRows },
                timeline: {
                  create: {
                    type: 'created',
                    actor: 'system',
                    detail: `Ingested from n8n (${payload.source})`,
                  },
                },
              },
            })
            return { lead, created: true }
          }
          // Human-owned fields (stage, owner, follow-up, notes, replySent, a
          // manual winProbability override) survive re-ingestion.
          const computed = applyComputed(
            {
              leadScore: payload.leadScore,
              dealValueLow: payload.dealValueLow,
              dealValueHigh: payload.dealValueHigh,
              winProbability: existing.winProbability,
              winProbabilityOverridden: existing.winProbabilityOverridden,
            },
            settings,
          )
          const lead = await tx.lead.update({
            where: { id: existing.id },
            data: { ...aiFields, ...computed },
          })
          await tx.thread.deleteMany({ where: { leadId: existing.id } })
          if (threadRows.length > 0) {
            await tx.thread.createMany({ data: threadRows.map((row) => ({ ...row, leadId: existing.id })) })
          }
          return { lead, created: false }
        })

      let result
      try {
        result = await upsertOnce()
      } catch (err) {
        // Two concurrent first-time ingests can race on the unique constraint;
        // the loser retries and takes the update path.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          result = await upsertOnce()
        } else {
          throw err
        }
      }
      return reply.status(result.created ? 201 : 200).send({ id: result.lead.id, created: result.created })
    },
  )
}
