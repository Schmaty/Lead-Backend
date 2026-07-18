import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { authGuard, requireRole } from '../../middleware/authGuard.js'
import { AppError } from '../../middleware/errorHandler.js'
import { workspaceId } from '../../middleware/workspaceScope.js'
import { audit } from '../../services/audit.js'
import { applyComputed, computeExpectedValue } from '../../services/leadCompute.js'
import { getPlatformAnthropicKey, getZohoConfig } from '../../services/platformCredentials.js'
import { syncLeadCrm } from '../../services/crmSync.js'
import { createAnthropic } from '../../modules/pipeline/scorer.js'
import { createCrmLead, crmCreateLeadUrl } from '../../services/zoho.js'
import { resolveSettings, type WorkspaceSettings } from '../../types/settings.js'
import { buildLeadWhere, computeAggregates } from './query.js'
import {
  createLeadSchema,
  listLeadsQuerySchema,
  patchLeadSchema,
  SAFE_PATCH_FIELDS,
  type ListLeadsQuery,
} from './schemas.js'
import { serializeLead } from './serialize.js'

const CSV_EXPORT_LIMIT = 10_000

const CSV_COLUMNS = [
  'id',
  'receivedAt',
  'name',
  'email',
  'org',
  'source',
  'inquiryType',
  'stage',
  'tier',
  'fitScore',
  'urgencyScore',
  'leadScore',
  'dealValueLow',
  'dealValueHigh',
  'winProbability',
  'expectedValue',
  'owner',
  'followUpDate',
  'replySent',
  'summary',
  'notes',
] as const

function csvCell(value: unknown): string {
  let text = value == null ? '' : value instanceof Date ? value.toISOString() : String(value)
  // Guard against spreadsheet formula injection when the export is opened in Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`
  return text
}

function sortOrder(query: ListLeadsQuery): Prisma.LeadOrderByWithRelationInput {
  if (query.sort === 'followUpDate') {
    return { followUpDate: { sort: query.order, nulls: 'last' } }
  }
  return { [query.sort]: query.order } as Prisma.LeadOrderByWithRelationInput
}

export default async function leadsRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app
  const guard = authGuard(app)
  const ownerSelect = { select: { id: true, name: true } } as const

  async function getSettings(wsId: string): Promise<WorkspaceSettings> {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: wsId } })
    return resolveSettings(workspace.settings)
  }

  // ── List with filters, sort, search, pagination + aggregates ──────────────
  app.get('/', { preHandler: [guard] }, async (request) => {
    const wsId = workspaceId(request)
    const query = listLeadsQuerySchema.parse(request.query)
    const settings = await getSettings(wsId)
    const where = buildLeadWhere(wsId, query, settings)
    const [items, aggregates] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: sortOrder(query),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          owner: ownerSelect,
          ...(query.include.threads ? { threads: { orderBy: { date: 'asc' as const } } } : {}),
          ...(query.include.timeline ? { timeline: { orderBy: { at: 'asc' as const } } } : {}),
        },
      }),
      computeAggregates(prisma, where, settings),
    ])
    return {
      items: items.map(serializeLead),
      page: query.page,
      pageSize: query.pageSize,
      total: aggregates.total,
      aggregates,
    }
  })

  // ── CSV export under the same filters ──────────────────────────────────────
  app.get('/export.csv', { preHandler: [guard] }, async (request, reply) => {
    const wsId = workspaceId(request)
    const query = listLeadsQuerySchema.parse(request.query)
    const settings = await getSettings(wsId)
    const where = buildLeadWhere(wsId, query, settings)
    const leads = await prisma.lead.findMany({
      where,
      orderBy: sortOrder(query),
      take: CSV_EXPORT_LIMIT,
      include: { owner: ownerSelect },
    })
    const rows = [CSV_COLUMNS.join(',')]
    for (const lead of leads) {
      rows.push(
        CSV_COLUMNS.map((column) =>
          csvCell(column === 'owner' ? (lead.owner?.name ?? '') : lead[column as keyof typeof lead]),
        ).join(','),
      )
    }
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="leads-export.csv"')
      .send(rows.join('\r\n') + '\r\n')
  })

  // ── Detail incl. threads + timeline + people + meetings ────────────────────
  app.get('/:id', { preHandler: [guard] }, async (request) => {
    const wsId = workspaceId(request)
    const { id } = request.params as { id: string }
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: wsId, deletedAt: null },
      include: {
        owner: ownerSelect,
        threads: { orderBy: { date: 'asc' } },
        timeline: { orderBy: { at: 'asc' } },
        people: { orderBy: { lastSeenAt: 'desc' } },
        meetings: { orderBy: { startsAt: 'desc' } },
      },
    })
    if (!lead) throw new AppError(404, 'Lead not found')
    const lastStageChange = [...lead.timeline].reverse().find((event) => event.type === 'stage_change')
    const stageSince = lastStageChange?.at ?? lead.createdAt
    const timeInStageHours = Math.round(((Date.now() - stageSince.getTime()) / 3_600_000) * 10) / 10
    return { ...serializeLead(lead), timeInStageHours }
  })

  // ── CRM (Zoho) — read now, push coming soon ────────────────────────────────
  app.get('/:id/crm', { preHandler: [guard] }, async (request) => {
    const wsId = workspaceId(request)
    const { id } = request.params as { id: string }
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: wsId, deletedAt: null },
      include: { people: { select: { email: true } } },
    })
    if (!lead) throw new AppError(404, 'Lead not found')
    const zoho = await getZohoConfig(prisma, config)
    if (!zoho) {
      return { available: false, records: [], checkedAt: null, createUrl: null }
    }
    try {
      // Same pull the scan runs: caches on the lead, logs new matches,
      // backfills org + person phones. Exact email first, then AI keywords.
      const apiKey = await getPlatformAnthropicKey(prisma, config)
      const { records } = await syncLeadCrm(prisma, zoho, lead.id, apiKey ? { anthropic: createAnthropic(apiKey) } : {})
      return { available: true, records, checkedAt: new Date(), createUrl: crmCreateLeadUrl() }
    } catch (err) {
      app.log.error({ err, leadId: id }, 'zoho lookup failed')
      throw new AppError(502, 'CRM lookup failed — check the Zoho connection')
    }
  })

  /**
   * Push this lead into Zoho as a new Lead. Needs a WRITE-scoped Zoho token; the
   * default read-only connection returns 200 { ok:false, scopeError:true } with
   * the create-form URL so the UI can fall back to the prefilled Zoho form.
   */
  app.post('/:id/crm/push', { preHandler: [guard, requireRole('OWNER', 'ADMIN')] }, async (request, reply) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const { id } = request.params as { id: string }
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: wsId, deletedAt: null },
      include: { people: true },
    })
    if (!lead) throw new AppError(404, 'Lead not found')
    const zoho = await getZohoConfig(prisma, config)
    if (!zoho) throw new AppError(400, 'Zoho CRM isn’t connected — add it under Settings → Platform')

    const [first, ...rest] = (lead.name || '').trim().split(/\s+/).filter(Boolean)
    const phone = lead.people.find((p) => p.phone)?.phone ?? ''
    const value = lead.estPayoutRaw || (lead.dealValueHigh ? `$${lead.dealValueLow}–${lead.dealValueHigh}` : '')
    const description = [
      lead.summary,
      value ? `Estimated value: ${value}` : '',
      lead.inquiryType ? `Inquiry: ${lead.inquiryType}` : '',
      `Lead score: ${lead.leadScore}/10 · stage: ${lead.stage}`,
      lead.recommendedNextStep ? `Next step: ${lead.recommendedNextStep}` : '',
      'Added from Leadline.',
    ].filter(Boolean).join('\n')

    const result = await createCrmLead(zoho, {
      firstName: rest.length ? first ?? '' : '',
      lastName: rest.length ? rest.join(' ') : first ?? '',
      email: lead.email,
      company: lead.org,
      phone,
      description,
    })

    if (!result.ok) {
      return reply.status(result.scopeError ? 200 : 502).send({
        ok: false,
        scopeError: result.scopeError,
        error: result.message,
        createUrl: crmCreateLeadUrl(),
      })
    }

    const record = {
      module: 'Leads' as const,
      id: result.id,
      name: lead.name,
      company: lead.org,
      email: lead.email,
      phone,
      url: result.url,
      matchVia: 'email' as const,
    }
    const existing = (lead.crmRecords ?? []) as Array<{ module?: string; id?: string }>
    await prisma.$transaction([
      prisma.lead.update({
        where: { id: lead.id },
        data: { crmRecords: [...existing, record] as unknown as Prisma.InputJsonValue, crmCheckedAt: new Date() },
      }),
      prisma.timelineEvent.create({
        data: { leadId: lead.id, type: 'crm_push', actor: auth.name, detail: `Pushed to Zoho CRM as a new lead — ${lead.name}` },
      }),
    ])
    await audit(prisma, { workspaceId: wsId, userId: auth.userId, action: 'lead.crm_pushed', target: result.id, ip: request.ip })
    return reply.status(201).send({ ok: true, id: result.id, url: result.url })
  })

  // ── Manual add ─────────────────────────────────────────────────────────────
  app.post('/', { preHandler: [guard] }, async (request, reply) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const body = createLeadSchema.parse(request.body)
    const settings = await getSettings(wsId)
    if (!settings.stages.includes(body.stage)) {
      throw new AppError(400, `Unknown stage "${body.stage}"`, { allowedStages: settings.stages })
    }
    let ownerId: string | null = null
    if (body.ownerId && body.ownerId !== 'unassigned') {
      const owner = await prisma.user.findFirst({ where: { id: body.ownerId, workspaceId: wsId } })
      if (!owner) throw new AppError(400, 'ownerId does not match a user in this workspace')
      ownerId = owner.id
    }
    const computed = applyComputed(
      { leadScore: body.leadScore, dealValueLow: body.dealValueLow, dealValueHigh: body.dealValueHigh },
      settings,
    )
    const lead = await prisma.lead.create({
      data: {
        workspaceId: wsId,
        receivedAt: body.receivedAt ?? new Date(),
        name: body.name,
        email: body.email,
        org: body.org,
        source: body.source,
        inquiryType: body.inquiryType,
        summary: body.summary,
        fitScore: body.fitScore,
        urgencyScore: body.urgencyScore,
        leadScore: body.leadScore,
        dealValueLow: body.dealValueLow,
        dealValueHigh: body.dealValueHigh,
        estPayoutRaw: body.estPayoutRaw,
        estWork: body.estWork,
        recommendedNextStep: body.recommendedNextStep,
        draftReply: body.draftReply,
        fitReasons: body.fitReasons,
        riskFlags: body.riskFlags,
        inferredFields: body.inferredFields,
        stage: body.stage,
        ownerId,
        followUpDate: body.followUpDate ?? null,
        notes: body.notes,
        replySent: body.replySent,
        lastTouchedAt: new Date(),
        ...computed,
        timeline: { create: { type: 'created', actor: auth.name, detail: 'Lead created manually' } },
      },
      include: { owner: ownerSelect, threads: true, timeline: true },
    })
    return reply.status(201).send(serializeLead(lead))
  })

  // ── PATCH: safe fields only ────────────────────────────────────────────────
  app.patch('/:id', { preHandler: [guard] }, async (request) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const { id } = request.params as { id: string }

    const raw = request.body
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new AppError(400, 'Request body must be a JSON object')
    }
    const offending = Object.keys(raw).filter(
      (key) => !(SAFE_PATCH_FIELDS as readonly string[]).includes(key),
    )
    if (offending.length > 0) {
      throw new AppError(400, 'These fields are AI-scored or computed and cannot be patched', {
        rejectedFields: offending,
        allowedFields: SAFE_PATCH_FIELDS,
      })
    }
    const body = patchLeadSchema.parse(raw)
    const settings = await getSettings(wsId)

    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: wsId, deletedAt: null },
      include: { owner: ownerSelect },
    })
    if (!lead) throw new AppError(404, 'Lead not found')

    const data: Prisma.LeadUncheckedUpdateInput = {}
    const events: Array<{ type: string; detail: string }> = []

    if (body.stage !== undefined && body.stage !== lead.stage) {
      if (!settings.stages.includes(body.stage)) {
        throw new AppError(400, `Unknown stage "${body.stage}"`, { allowedStages: settings.stages })
      }
      data.stage = body.stage
      // A human move pins the stage: AI re-scores won't reposition it afterwards.
      data.stageOverridden = true
      events.push({ type: 'stage_change', detail: `${lead.stage} → ${body.stage}` })
    }

    if (body.ownerId !== undefined) {
      const nextOwnerId = body.ownerId === 'unassigned' ? null : body.ownerId
      if (nextOwnerId !== lead.ownerId) {
        let nextOwnerName = 'Unassigned'
        if (nextOwnerId !== null) {
          const owner = await prisma.user.findFirst({
            where: { id: nextOwnerId, workspaceId: wsId },
            select: { name: true },
          })
          if (!owner) throw new AppError(400, 'ownerId does not match a user in this workspace')
          nextOwnerName = owner.name
        }
        data.ownerId = nextOwnerId
        events.push({
          type: 'owner_change',
          detail: `${lead.owner?.name ?? 'Unassigned'} → ${nextOwnerName}`,
        })
      }
    }

    if (body.followUpDate !== undefined) {
      const next = body.followUpDate?.getTime() ?? null
      const current = lead.followUpDate?.getTime() ?? null
      if (next !== current) {
        data.followUpDate = body.followUpDate
        events.push({
          type: 'follow_up_set',
          detail: body.followUpDate
            ? `Follow-up set for ${body.followUpDate.toISOString().slice(0, 10)}`
            : 'Follow-up cleared',
        })
      }
    }

    if (body.notes !== undefined && body.notes !== lead.notes) {
      data.notes = body.notes
      events.push({ type: 'note_added', detail: 'Notes updated' })
    }

    if (body.replySent !== undefined && body.replySent !== lead.replySent) {
      data.replySent = body.replySent
      events.push({
        type: 'reply_sent',
        detail: body.replySent ? 'Reply marked as sent' : 'Reply marked as not sent',
      })
    }

    if (body.winProbability !== undefined && body.winProbability !== lead.winProbability) {
      data.winProbability = body.winProbability
      data.winProbabilityOverridden = true
      data.expectedValue = computeExpectedValue(lead.dealValueLow, lead.dealValueHigh, body.winProbability)
      events.push({
        type: 'win_probability_set',
        detail: `Win probability manually set to ${Math.round(body.winProbability * 100)}%`,
      })
    }

    if (Object.keys(data).length === 0) {
      return serializeLead(lead)
    }
    data.lastTouchedAt = new Date()

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.lead.update({
        where: { id: lead.id },
        data,
        include: { owner: ownerSelect },
      })
      if (events.length > 0) {
        await tx.timelineEvent.createMany({
          data: events.map((event) => ({ leadId: lead.id, actor: auth.name, ...event })),
        })
      }
      return result
    })
    return serializeLead(updated)
  })

  // ── Soft delete (ADMIN/OWNER) ──────────────────────────────────────────────
  app.delete('/:id', { preHandler: [guard, requireRole('ADMIN', 'OWNER')] }, async (request) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const { id } = request.params as { id: string }
    const lead = await prisma.lead.findFirst({ where: { id, workspaceId: wsId, deletedAt: null } })
    if (!lead) throw new AppError(404, 'Lead not found')
    await prisma.lead.update({ where: { id: lead.id }, data: { deletedAt: new Date() } })
    await audit(prisma, {
      workspaceId: wsId,
      userId: auth.userId,
      action: 'lead.deleted',
      target: `${lead.id} (${lead.name})`,
      ip: request.ip,
    })
    return { ok: true }
  })
}
