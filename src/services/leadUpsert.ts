import { Prisma, type Lead, type PrismaClient } from '@prisma/client'
import type { WorkspaceSettings } from '../types/settings.js'
import { applyComputed } from './leadCompute.js'

export interface UpsertThread {
  subject: string
  url: string
  direction: 'in' | 'out'
  date: Date
  snippet: string
}

export interface UpsertLeadInput {
  externalId: string
  receivedAt: Date
  name: string
  email: string
  org: string
  source: string
  inquiryType: string
  summary: string
  fitScore: number
  urgencyScore: number
  leadScore: number
  dealValueLow: number
  dealValueHigh: number
  estPayoutRaw: string
  estWork: string
  recommendedNextStep: string
  draftReply: string
  fitReasons: string[]
  riskFlags: string[]
  inferredFields: string[]
  threads: UpsertThread[]
  /** Stage for first insert only (updates never touch the human-owned stage). */
  initialStage: string
  /** Detail line for the `created` timeline event. */
  createdDetail: string
}

/**
 * Idempotent upsert by (workspaceId, externalId): re-runs update the AI-owned
 * fields and replace threads; human-owned fields (stage, owner, follow-up,
 * notes, replySent, a manual winProbability override) survive re-ingestion.
 * Shared by the ingest webhook and the built-in inbox scanner.
 */
export async function upsertLeadByExternalId(
  prisma: PrismaClient,
  workspaceId: string,
  settings: WorkspaceSettings,
  input: UpsertLeadInput,
): Promise<{ lead: Lead; created: boolean }> {
  const aiFields = {
    receivedAt: input.receivedAt,
    name: input.name,
    email: input.email,
    org: input.org,
    source: input.source,
    inquiryType: input.inquiryType,
    summary: input.summary,
    fitScore: input.fitScore,
    urgencyScore: input.urgencyScore,
    leadScore: input.leadScore,
    dealValueLow: input.dealValueLow,
    dealValueHigh: input.dealValueHigh,
    estPayoutRaw: input.estPayoutRaw,
    estWork: input.estWork,
    recommendedNextStep: input.recommendedNextStep,
    draftReply: input.draftReply,
    fitReasons: input.fitReasons,
    riskFlags: input.riskFlags,
    inferredFields: input.inferredFields,
  }
  const threadRows = input.threads.map((thread) => ({
    subject: thread.subject,
    url: thread.url,
    direction: thread.direction,
    date: thread.date,
    snippet: thread.snippet,
  }))

  const upsertOnce = () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.lead.findUnique({
        where: { workspaceId_externalId: { workspaceId, externalId: input.externalId } },
      })
      if (!existing) {
        const computed = applyComputed(input, settings)
        const lead = await tx.lead.create({
          data: {
            workspaceId,
            externalId: input.externalId,
            ...aiFields,
            ...computed,
            stage: input.initialStage,
            lastTouchedAt: input.receivedAt,
            threads: { create: threadRows },
            timeline: {
              create: { type: 'created', actor: 'system', detail: input.createdDetail },
            },
          },
        })
        return { lead, created: true }
      }
      const computed = applyComputed(
        {
          leadScore: input.leadScore,
          dealValueLow: input.dealValueLow,
          dealValueHigh: input.dealValueHigh,
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

  try {
    return await upsertOnce()
  } catch (err) {
    // Two concurrent first-time upserts can race on the unique constraint; the
    // loser retries and takes the update path.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return upsertOnce()
    }
    throw err
  }
}
