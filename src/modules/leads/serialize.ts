import type { Lead, Meeting, Person, Thread, TimelineEvent } from '@prisma/client'

export type LeadWithRelations = Lead & {
  owner?: { id: string; name: string } | null
  threads?: Thread[]
  timeline?: TimelineEvent[]
  people?: Person[]
  meetings?: Meeting[]
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
    crmRecords: lead.crmRecords,
    crmCheckedAt: lead.crmCheckedAt,
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
      personId: thread.personId,
    }))
  }
  if (lead.people !== undefined) {
    out.people = lead.people.map((person) => ({
      id: person.id,
      name: person.name,
      email: person.email,
      role: person.role,
      phone: person.phone,
      notes: person.notes,
      firstSeenAt: person.firstSeenAt,
      lastSeenAt: person.lastSeenAt,
    }))
  }
  if (lead.meetings !== undefined) {
    out.meetings = lead.meetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      startsAt: meeting.startsAt,
      endsAt: meeting.endsAt,
      attendees: meeting.attendees,
      tldr: meeting.tldr,
      dossier: meeting.dossier,
      url: meeting.url,
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
