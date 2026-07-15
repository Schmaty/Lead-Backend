import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authGuard } from '../../middleware/authGuard.js'
import { workspaceId } from '../../middleware/workspaceScope.js'
import { resolveSettings } from '../../types/settings.js'
import { isoDate } from '../leads/schemas.js'

const DEFAULT_RANGE_DAYS = 90

const analyticsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
})

const SCORE_BANDS: Array<{ band: string; min: number; max: number }> = [
  { band: '0-2', min: 0, max: 2 },
  { band: '3-4', min: 3, max: 4 },
  { band: '5-6', min: 5, max: 6 },
  { band: '7-8', min: 7, max: 8 },
  { band: '9-10', min: 9, max: 10 },
]

const round2 = (value: number) => Math.round(value * 100) / 100
const sum = (values: number[]) => values.reduce((acc, value) => acc + value, 0)
const mean = (values: number[]) => (values.length > 0 ? sum(values) / values.length : null)

/** ISO week key, e.g. "2026-W28". */
function isoWeek(input: Date): string {
  const date = new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

function weeklySeries(entries: Array<{ week: string; value: number }>, aggregate: 'sum' | 'mean') {
  const grouped = new Map<string, number[]>()
  for (const entry of entries) {
    const bucket = grouped.get(entry.week) ?? []
    bucket.push(entry.value)
    grouped.set(entry.week, bucket)
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, values]) => ({
      week,
      value: round2(aggregate === 'sum' ? sum(values) : (mean(values) ?? 0)),
    }))
}

export default async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app
  const guard = authGuard(app)

  app.get('/', { preHandler: [guard] }, async (request) => {
    const wsId = workspaceId(request)
    const query = analyticsQuerySchema.parse(request.query)
    const to = query.to ?? new Date()
    const from = query.from ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * 86_400_000)

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: wsId } })
    const settings = resolveSettings(workspace.settings)

    const leads = await prisma.lead.findMany({
      where: { workspaceId: wsId, deletedAt: null, receivedAt: { gte: from, lte: to } },
      select: {
        stage: true,
        source: true,
        receivedAt: true,
        leadScore: true,
        dealValueLow: true,
        dealValueHigh: true,
        expectedValue: true,
        timeline: {
          where: { type: 'reply_sent' },
          orderBy: { at: 'asc' },
          take: 1,
          select: { at: true },
        },
      },
    })

    const midValue = (lead: { dealValueLow: number; dealValueHigh: number }) =>
      (lead.dealValueLow + lead.dealValueHigh) / 2
    const won = leads.filter((lead) => lead.stage === settings.wonStage)
    const lost = leads.filter((lead) => lead.stage === settings.lostStage)
    const open = leads.filter((lead) => !settings.closedStages.includes(lead.stage))

    // Funnel in the workspace's configured stage order (plus any stray stages).
    const stageOrder = [...settings.stages]
    for (const lead of leads) {
      if (!stageOrder.includes(lead.stage)) stageOrder.push(lead.stage)
    }
    const funnel = stageOrder.map((stage) => ({
      stage,
      count: leads.filter((lead) => lead.stage === stage).length,
    }))

    const decidedCount = won.length + lost.length
    const winRate = decidedCount > 0 ? round2(won.length / decidedCount) : null

    const responseSamples = leads
      .filter((lead) => lead.timeline.length > 0)
      .map((lead) => ({
        week: isoWeek(lead.receivedAt),
        value: Math.max(0, (lead.timeline[0]!.at.getTime() - lead.receivedAt.getTime()) / 3_600_000),
      }))

    const sources = [...new Set(leads.map((lead) => lead.source))].sort()
    const sourcePerformance = sources.map((source) => {
      const ofSource = leads.filter((lead) => lead.source === source)
      const sourceWon = ofSource.filter((lead) => lead.stage === settings.wonStage)
      const sourceLost = ofSource.filter((lead) => lead.stage === settings.lostStage)
      const decided = sourceWon.length + sourceLost.length
      return {
        source,
        count: ofSource.length,
        won: sourceWon.length,
        lost: sourceLost.length,
        winRate: decided > 0 ? round2(sourceWon.length / decided) : null,
        wonValue: round2(sum(sourceWon.map(midValue))),
      }
    })

    const scoreCalibration = SCORE_BANDS.map(({ band, min, max }) => {
      const inBand = leads.filter((lead) => lead.leadScore >= min && lead.leadScore <= max)
      const bandWon = inBand.filter((lead) => lead.stage === settings.wonStage).length
      const bandLost = inBand.filter((lead) => lead.stage === settings.lostStage).length
      const decided = bandWon + bandLost
      return {
        band,
        count: inBand.length,
        won: bandWon,
        lost: bandLost,
        winRate: decided > 0 ? round2(bandWon / decided) : null,
      }
    })

    const avgFirstResponse = mean(responseSamples.map((sample) => sample.value))
    return {
      range: { from, to },
      totalLeads: leads.length,
      funnel,
      winRate,
      wonCount: won.length,
      lostCount: lost.length,
      avgDealSize: won.length > 0 ? round2(sum(won.map(midValue)) / won.length) : null,
      totalWonValue: round2(sum(won.map(midValue))),
      pipelineExpectedValue: round2(sum(open.map((lead) => lead.expectedValue))),
      leadsPerWeek: weeklySeries(
        leads.map((lead) => ({ week: isoWeek(lead.receivedAt), value: 1 })),
        'sum',
      ).map(({ week, value }) => ({ week, count: value })),
      expectedPipelineTrend: weeklySeries(
        open.map((lead) => ({ week: isoWeek(lead.receivedAt), value: lead.expectedValue })),
        'sum',
      ).map(({ week, value }) => ({ week, expectedValue: value })),
      firstResponse: {
        avgHours: avgFirstResponse !== null ? round2(avgFirstResponse) : null,
        trend: weeklySeries(responseSamples, 'mean').map(({ week, value }) => ({ week, avgHours: value })),
      },
      sourcePerformance,
      scoreCalibration,
    }
  })
}
