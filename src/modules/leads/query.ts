import type { Prisma, PrismaClient } from '@prisma/client'
import type { WorkspaceSettings } from '../../types/settings.js'
import type { ListLeadsQuery } from './schemas.js'

const RECENT_UNASSIGNED_WINDOW_MS = 7 * 24 * 3600 * 1000

export function overdueFilter(settings: WorkspaceSettings, now = new Date()): Prisma.LeadWhereInput {
  return { followUpDate: { lt: now }, stage: { notIn: settings.closedStages } }
}

/** needsAttention = hot OR overdue OR (unassigned AND received in the last 7 days). */
export function needsAttentionFilter(settings: WorkspaceSettings, now = new Date()): Prisma.LeadWhereInput {
  return {
    OR: [
      { tier: 'hot' },
      overdueFilter(settings, now),
      { AND: [{ ownerId: null }, { receivedAt: { gte: new Date(now.getTime() - RECENT_UNASSIGNED_WINDOW_MS) } }] },
    ],
  }
}

const SEARCH_FIELDS = ['name', 'org', 'email', 'summary', 'notes'] as const

export function buildLeadWhere(
  workspaceId: string,
  query: ListLeadsQuery,
  settings: WorkspaceSettings,
  now = new Date(),
): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = []

  if (query.stage) and.push({ stage: { in: query.stage } })
  if (query.tier) and.push({ tier: { in: query.tier } })
  if (query.inquiryType) and.push({ inquiryType: { in: query.inquiryType } })
  if (query.source) and.push({ source: { in: query.source } })

  if (query.ownerId) {
    const ids = query.ownerId.filter((value) => value !== 'unassigned')
    const wantsUnassigned = query.ownerId.includes('unassigned')
    const or: Prisma.LeadWhereInput[] = []
    if (ids.length > 0) or.push({ ownerId: { in: ids } })
    if (wantsUnassigned) or.push({ ownerId: null })
    if (or.length > 0) and.push({ OR: or })
  }

  const range = (
    field: 'fitScore' | 'urgencyScore' | 'leadScore' | 'expectedValue',
    min: number | undefined,
    max: number | undefined,
  ) => {
    if (min === undefined && max === undefined) return
    and.push({
      [field]: {
        ...(min !== undefined ? { gte: min } : {}),
        ...(max !== undefined ? { lte: max } : {}),
      },
    })
  }
  range('fitScore', query.fitMin, query.fitMax)
  range('urgencyScore', query.urgencyMin, query.urgencyMax)
  range('leadScore', query.leadMin, query.leadMax)
  range('expectedValue', query.expectedMin, query.expectedMax)

  if (query.receivedFrom || query.receivedTo) {
    and.push({
      receivedAt: {
        ...(query.receivedFrom ? { gte: query.receivedFrom } : {}),
        ...(query.receivedTo ? { lte: query.receivedTo } : {}),
      },
    })
  }
  if (query.followUpFrom || query.followUpTo) {
    and.push({
      followUpDate: {
        ...(query.followUpFrom ? { gte: query.followUpFrom } : {}),
        ...(query.followUpTo ? { lte: query.followUpTo } : {}),
      },
    })
  }
  if (query.overdue) and.push(overdueFilter(settings, now))
  if (query.replySent !== undefined) and.push({ replySent: query.replySent })
  if (query.needsAttention) and.push(needsAttentionFilter(settings, now))

  if (query.search) {
    const term = query.search
    and.push({
      OR: SEARCH_FIELDS.map((field) => ({ [field]: { contains: term, mode: 'insensitive' as const } })),
    })
  }

  return { workspaceId, deletedAt: null, AND: and }
}

const round2 = (value: number) => Math.round(value * 100) / 100

export interface LeadAggregates {
  total: number
  countByStage: Record<string, number>
  countByTier: Record<string, number>
  pipelineExpectedValue: number
  wonCount: number
  wonValue: number
  overdueCount: number
  unassignedCount: number
  needsAttentionCount: number
}

/** Aggregates computed under the SAME filters as the list itself. */
export async function computeAggregates(
  prisma: PrismaClient,
  where: Prisma.LeadWhereInput,
  settings: WorkspaceSettings,
): Promise<LeadAggregates> {
  const openWhere: Prisma.LeadWhereInput = { AND: [where, { stage: { notIn: settings.closedStages } }] }
  const wonWhere: Prisma.LeadWhereInput = { AND: [where, { stage: settings.wonStage }] }

  const [total, byStage, byTier, pipeline, won, overdueCount, unassignedCount, needsAttentionCount] =
    await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.groupBy({ by: ['stage'], where, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['tier'], where, _count: { _all: true } }),
      prisma.lead.aggregate({ where: openWhere, _sum: { expectedValue: true } }),
      prisma.lead.aggregate({
        where: wonWhere,
        _sum: { dealValueLow: true, dealValueHigh: true },
        _count: { _all: true },
      }),
      prisma.lead.count({ where: { AND: [where, overdueFilter(settings)] } }),
      prisma.lead.count({ where: { AND: [where, { ownerId: null }] } }),
      prisma.lead.count({ where: { AND: [where, needsAttentionFilter(settings)] } }),
    ])

  return {
    total,
    countByStage: Object.fromEntries(byStage.map((row) => [row.stage, row._count._all])),
    countByTier: Object.fromEntries(byTier.map((row) => [row.tier, row._count._all])),
    pipelineExpectedValue: round2(pipeline._sum.expectedValue ?? 0),
    wonCount: won._count._all,
    wonValue: round2(((won._sum.dealValueLow ?? 0) + (won._sum.dealValueHigh ?? 0)) / 2),
    overdueCount,
    unassignedCount,
    needsAttentionCount,
  }
}
