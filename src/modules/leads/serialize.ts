import type { Lead, Thread, TimelineEvent } from '@prisma/client'

export type LeadWithRelations = Lead & {
  owner?: { id: string; name: string } | null
  threads?: Thread[]
  timeline?: TimelineEvent[]
}

/** Wire format for the dashboard: camelCase, no soft-delete internals. */
export function serializeLead(lead: LeadWithRelations): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: lead.id,
    externalId: lead.externalId,
    receivedAt: lead.receivedAt,
    name: lead.name,
    email: lead.email,
    org: lead.org,
    source: lead.source,
    inquiryType: lead.inquiryType,
    summary: lead.summary,
    fitScore: lead.fitScore,
    urgencyScore: lead.urgencyScore,
    leadScore: lead.leadScore,
    tier: lead.tier,
    dealValueLow: lead.dealValueLow,
    dealValueHigh: lead.dealValueHigh,
    estPayoutRaw: lead.estPayoutRaw,
    winProbability: lead.winProbability,
    winProbabilityOverridden: lead.winProbabilityOverridden,
    expectedValue: lead.expectedValue,
    estWork: lead.estWork,
    recommendedNextStep: lead.recommendedNextStep,
    draftReply: lead.draftReply,
    fitReasons: lead.fitReasons,
    riskFlags: lead.riskFlags,
    inferredFields: lead.inferredFields,
    stage: lead.stage,
    ownerId: lead.ownerId,
    followUpDate: lead.followUpDate,
    replySent: lead.replySent,
    lastTouchedAt: lead.lastTouchedAt,
    notes: lead.notes,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  }
  if (lead.owner !== undefined) {
    out.owner = lead.owner ? { id: lead.owner.id, name: lead.owner.name } : null
  }
  if (lead.threads !== undefined) {
    out.threads = lead.threads.map((thread) => ({
      id: thread.id,
      subject: thread.subject,
      url: thread.url,
      direction: thread.direction,
      date: thread.date,
      snippet: thread.snippet,
    }))
  }
  if (lead.timeline !== undefined) {
    out.timeline = lead.timeline.map((event) => ({
      id: event.id,
      type: event.type,
      at: event.at,
      actor: event.actor,
      detail: event.detail,
    }))
  }
  return out
}
