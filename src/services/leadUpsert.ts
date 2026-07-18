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
  /**
   * The stage the AI/CRM believes the deal is at. Used verbatim on insert, and
   * on merge it repositions the lead — UNLESS a human has pinned the stage
   * (stageOverridden). This is how new emails update a CRM-imported lead's
   * pipeline position.
   */
  initialStage: string
  /** The deal's real activity date (from the email content), if any. */
  activityDate?: Date | null
  /** Detail line for the `created` timeline event. */
  createdDetail: string
}

export interface UpsertOptions {
  /**
   * How `input.threads` combines with what's stored:
   * - 'replace' (webhook): the payload is the authoritative set — swap it in.
   * - 'merge' (scanner): the payload is the newly seen messages — append the
   *   ones not already stored (by url), keep the rest, log `email_received`
   *   timeline events for new inbound messages, and preserve `receivedAt`
   *   (first contact) while bumping `lastTouchedAt` to the newest message.
   */
  threadMode?: 'replace' | 'merge'
}

export interface UpsertOutcome {
  lead: Lead
  created: boolean
  /** How many messages from input.threads were actually new (merge mode). */
  addedThreads: number
}

/**
 * Idempotent upsert by (workspaceId, externalId): re-runs update the AI-owned
 * fields; human-owned fields (stage, owner, follow-up, notes, replySent, a
 * manual winProbability override) survive re-ingestion. Shared by the ingest
 * webhook (thread replace) and the built-in inbox scanner (thread merge).
 */
export async function upsertLeadByExternalId(
  prisma: PrismaClient,
  workspaceId: string,
  settings: WorkspaceSettings,
  input: UpsertLeadInput,
  options: UpsertOptions = {},
): Promise<UpsertOutcome> {
  const threadMode = options.threadMode ?? 'replace'
  const aiFields = {
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
  const newestThreadAt = threadRows.reduce(
    (max, row) => (row.date > max ? row.date : max),
    input.receivedAt,
  )

  const upsertOnce = () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.lead.findUnique({
        where: { workspaceId_externalId: { workspaceId, externalId: input.externalId } },
        include: { threads: { select: { url: true } } },
      })
      if (!existing) {
        const computed = applyComputed(input, settings)
        const lead = await tx.lead.create({
          data: {
            workspaceId,
            externalId: input.externalId,
            receivedAt: input.receivedAt,
            ...aiFields,
            ...computed,
            stage: input.initialStage,
            activityDate: input.activityDate ?? null,
            lastTouchedAt: newestThreadAt,
            threads: { create: threadRows },
            timeline: {
              create: { type: 'created', actor: 'system', detail: input.createdDetail },
            },
          },
        })
        return { lead, created: true, addedThreads: threadRows.length }
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

      let addedThreads = 0
      if (threadMode === 'merge') {
        const known = new Set(existing.threads.map((t) => t.url))
        const fresh = threadRows.filter((row) => !known.has(row.url))
        addedThreads = fresh.length
        if (fresh.length > 0) {
          await tx.thread.createMany({ data: fresh.map((row) => ({ ...row, leadId: existing.id })) })
          await tx.timelineEvent.createMany({
            data: fresh
              .filter((row) => row.direction === 'in')
              .map((row) => ({
                leadId: existing.id,
                type: 'email_received',
                actor: 'system',
                detail: `New email in thread: "${row.subject}"`,
                at: row.date,
              })),
          })
        }
      } else {
        await tx.thread.deleteMany({ where: { leadId: existing.id } })
        if (threadRows.length > 0) {
          await tx.thread.createMany({ data: threadRows.map((row) => ({ ...row, leadId: existing.id })) })
        }
        addedThreads = threadRows.length
      }

      // New activity can reposition the deal in the pipeline — but a human's
      // manual stage move (stageOverridden) is final and never auto-changed.
      const reposition =
        !existing.stageOverridden && settings.stages.includes(input.initialStage) && input.initialStage !== existing.stage

      const lead = await tx.lead.update({
        where: { id: existing.id },
        data: {
          ...aiFields,
          ...computed,
          ...(reposition ? { stage: input.initialStage } : {}),
          ...(input.activityDate != null ? { activityDate: input.activityDate } : {}),
          // Replace mode: the sender owns receivedAt. Merge mode: first contact stays.
          ...(threadMode === 'replace' ? { receivedAt: input.receivedAt } : {}),
          ...(threadMode === 'merge' && addedThreads > 0 && newestThreadAt > existing.lastTouchedAt
            ? { lastTouchedAt: newestThreadAt }
            : {}),
        },
      })
      if (reposition) {
        await tx.timelineEvent.create({
          data: { leadId: existing.id, type: 'stage_change', actor: 'system', detail: `${existing.stage} → ${input.initialStage} — from new activity` },
        })
      }
      return { lead, created: false, addedThreads }
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
