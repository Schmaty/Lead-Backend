import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  addMember,
  api,
  createLead,
  daysAgo,
  daysFromNow,
  makeApp,
  resetDb,
  signup,
  type Session,
} from './helpers.js'

let app: FastifyInstance
let owner: Session
let member: Session
const idsByName = new Map<string, string>()

async function names(query: string): Promise<string[]> {
  const res = await api(app, owner, { method: 'GET', url: `/api/v1/leads?${query}` })
  expect(res.statusCode).toBe(200)
  return res
    .json()
    .items.map((item: { name: string }) => item.name)
    .sort()
}

beforeAll(async () => {
  app = await makeApp()
  await resetDb(app)
  owner = await signup(app, { email: 'owner@filters.test', workspaceName: 'Filters Co' })
  member = await addMember(app, owner, 'member@filters.test')

  const seed: Array<Record<string, unknown>> = [
    {
      name: 'Hot Harriet',
      email: 'h1@f.test',
      org: 'Northwind Logistics',
      stage: 'New',
      leadScore: 9,
      fitScore: 9,
      urgencyScore: 8,
      source: 'Email',
      inquiryType: 'New project / hot lead',
      receivedAt: daysAgo(1),
      dealValueLow: 6000,
      dealValueHigh: 12000,
    },
    {
      name: 'Warm Wanda',
      email: 'w2@f.test',
      org: 'Bluepeak Manufacturing',
      stage: 'Contacted',
      leadScore: 6,
      source: 'Website form',
      inquiryType: 'Training request',
      receivedAt: daysAgo(10),
      ownerId: 'MEMBER',
      followUpDate: daysAgo(2), // overdue: past follow-up on an open stage
      dealValueLow: 2000,
      dealValueHigh: 4000,
      summary: 'Renewal of forklift safety training for two shifts',
    },
    {
      name: 'Qualified Quinn',
      email: 'q3@f.test',
      stage: 'Qualified',
      leadScore: 5,
      fitScore: 4,
      source: 'Referral',
      inquiryType: 'Consulting inquiry',
      receivedAt: daysAgo(20),
      ownerId: 'MEMBER',
      followUpDate: daysFromNow(5),
      dealValueLow: 1000,
      dealValueHigh: 2000,
      notes: 'Met at the safety conference in March',
    },
    {
      name: 'Won Wendy',
      email: 'w4@f.test',
      stage: 'Closed won',
      leadScore: 9,
      source: 'Event',
      inquiryType: 'Workshop / speaking',
      receivedAt: daysAgo(30),
      ownerId: 'MEMBER',
      followUpDate: daysAgo(10), // closed stage → NOT overdue
      dealValueLow: 10000,
      dealValueHigh: 20000,
      replySent: true,
    },
    {
      name: 'Lost Larry',
      email: 'l5@f.test',
      stage: 'Closed lost',
      leadScore: 4,
      source: 'Email',
      inquiryType: 'Consulting inquiry',
      receivedAt: daysAgo(40),
      ownerId: 'OWNER',
      dealValueLow: 3000,
      dealValueHigh: 5000,
    },
    {
      name: 'Spam Sally',
      email: 's6@f.test',
      stage: 'Not fit',
      leadScore: 2,
      source: 'Other',
      inquiryType: 'Other',
      receivedAt: daysAgo(3),
    },
    {
      name: 'Old Oliver',
      email: 'o7@f.test',
      stage: 'New',
      leadScore: 3,
      fitScore: 2,
      source: 'Email',
      inquiryType: 'Vendor pitch',
      receivedAt: daysAgo(60),
    },
    {
      name: 'Proposal Petra',
      email: 'p8@f.test',
      stage: 'Proposal sent',
      leadScore: 8,
      source: 'Website form',
      inquiryType: 'New project / hot lead',
      receivedAt: daysAgo(5),
      ownerId: 'MEMBER',
      followUpDate: daysFromNow(2),
      dealValueLow: 4000,
      dealValueHigh: 8000,
    },
  ]

  for (const def of seed) {
    const payload = { ...def }
    if (payload.ownerId === 'MEMBER') payload.ownerId = member.user.id
    if (payload.ownerId === 'OWNER') payload.ownerId = owner.user.id
    const lead = await createLead(app, owner, payload)
    idsByName.set(lead.name, lead.id)
  }

  // Flip replySent via PATCH so reply_sent timeline events exist (feeds the
  // first-response analytics) — Wanda and Petra.
  for (const name of ['Warm Wanda', 'Proposal Petra']) {
    const res = await api(app, owner, {
      method: 'PATCH',
      url: `/api/v1/leads/${idsByName.get(name)}`,
      payload: { replySent: true },
    })
    expect(res.statusCode).toBe(200)
  }
})

afterAll(async () => {
  await app.close()
})

describe('filters', () => {
  it('stage (multi-value)', async () => {
    expect(await names('stage=New,Contacted')).toEqual(['Hot Harriet', 'Old Oliver', 'Warm Wanda'])
    expect(await names('stage=Closed%20won')).toEqual(['Won Wendy'])
  })

  it('tier', async () => {
    expect(await names('tier=hot')).toEqual(['Hot Harriet', 'Proposal Petra', 'Won Wendy'])
    expect(await names('tier=cold')).toEqual(['Lost Larry', 'Old Oliver', 'Spam Sally'])
  })

  it('score ranges (fit, urgency, lead)', async () => {
    expect(await names('leadMin=8')).toEqual(['Hot Harriet', 'Proposal Petra', 'Won Wendy'])
    expect(await names('leadMax=3')).toEqual(['Old Oliver', 'Spam Sally'])
    expect(await names('fitMin=9')).toEqual(['Hot Harriet'])
    expect(await names('fitMax=4')).toEqual(['Old Oliver', 'Qualified Quinn'])
    expect(await names('urgencyMin=8')).toEqual(['Hot Harriet'])
    expect(await names('leadMin=5&leadMax=6')).toEqual(['Qualified Quinn', 'Warm Wanda'])
  })

  it('inquiryType and source', async () => {
    expect(await names(`inquiryType=${encodeURIComponent('New project / hot lead')}`)).toEqual([
      'Hot Harriet',
      'Proposal Petra',
    ])
    expect(await names('source=Email')).toEqual(['Hot Harriet', 'Lost Larry', 'Old Oliver'])
    expect(await names('source=Email,Referral')).toEqual([
      'Hot Harriet',
      'Lost Larry',
      'Old Oliver',
      'Qualified Quinn',
    ])
  })

  it('ownerId incl. unassigned', async () => {
    expect(await names('ownerId=unassigned')).toEqual(['Hot Harriet', 'Old Oliver', 'Spam Sally'])
    expect(await names(`ownerId=${member.user.id}`)).toEqual([
      'Proposal Petra',
      'Qualified Quinn',
      'Warm Wanda',
      'Won Wendy',
    ])
    expect(await names(`ownerId=unassigned,${owner.user.id}`)).toEqual([
      'Hot Harriet',
      'Lost Larry',
      'Old Oliver',
      'Spam Sally',
    ])
  })

  it('received date range', async () => {
    expect(await names(`receivedFrom=${daysAgo(15)}`)).toEqual([
      'Hot Harriet',
      'Proposal Petra',
      'Spam Sally',
      'Warm Wanda',
    ])
    expect(await names(`receivedTo=${daysAgo(25)}`)).toEqual(['Lost Larry', 'Old Oliver', 'Won Wendy'])
  })

  it('follow-up range and overdue', async () => {
    const now = new Date().toISOString()
    expect(await names(`followUpFrom=${now}`)).toEqual(['Proposal Petra', 'Qualified Quinn'])
    expect(await names(`followUpTo=${now}`)).toEqual(['Warm Wanda', 'Won Wendy'])
    // Overdue excludes closed stages: Wendy's past follow-up doesn't count.
    expect(await names('overdue=true')).toEqual(['Warm Wanda'])
  })

  it('expectedValue range', async () => {
    // Petra (score 8) lands in the 7–8 band → p 0.35 → EV 2100, below this cut.
    expect(await names('expectedMin=3000')).toEqual(['Hot Harriet', 'Won Wendy'])
    expect(await names('expectedMax=300')).toEqual([
      'Lost Larry',
      'Old Oliver',
      'Qualified Quinn',
      'Spam Sally',
    ])
  })

  it('replySent', async () => {
    expect(await names('replySent=true')).toEqual(['Proposal Petra', 'Warm Wanda', 'Won Wendy'])
  })

  it('needsAttention = hot OR overdue OR recently-received unassigned', async () => {
    expect(await names('needsAttention=true')).toEqual([
      'Hot Harriet', // hot + unassigned recent
      'Proposal Petra', // hot
      'Spam Sally', // unassigned, received 3 days ago
      'Warm Wanda', // overdue
      'Won Wendy', // hot
    ])
  })

  it('search across name/org/email/summary/notes (case-insensitive)', async () => {
    expect(await names('search=northwind')).toEqual(['Hot Harriet'])
    expect(await names('search=q3%40f.test')).toEqual(['Qualified Quinn'])
    expect(await names('search=forklift')).toEqual(['Warm Wanda'])
    expect(await names('search=CONFERENCE')).toEqual(['Qualified Quinn'])
    expect(await names('search=petra')).toEqual(['Proposal Petra'])
    expect(await names('search=zzz-no-match')).toEqual([])
  })

  it('filters combine with AND', async () => {
    expect(await names('tier=hot&replySent=true')).toEqual(['Proposal Petra', 'Won Wendy'])
    expect(await names('source=Email&leadMin=5')).toEqual(['Hot Harriet'])
  })
})

describe('sorting and pagination', () => {
  it('sorts by leadScore ascending', async () => {
    const res = await api(app, owner, { method: 'GET', url: '/api/v1/leads?sort=leadScore&order=asc' })
    const scores = res.json().items.map((item: { leadScore: number }) => item.leadScore)
    expect(scores).toEqual([...scores].sort((a, b) => a - b))
    expect(res.json().items[0].name).toBe('Spam Sally')
  })

  it('sorts by name and paginates with a stable total', async () => {
    const page2 = await api(app, owner, {
      method: 'GET',
      url: '/api/v1/leads?sort=name&order=asc&pageSize=3&page=2',
    })
    const body = page2.json()
    expect(body.total).toBe(8)
    expect(body.page).toBe(2)
    expect(body.items.map((item: { name: string }) => item.name)).toEqual([
      'Proposal Petra',
      'Qualified Quinn',
      'Spam Sally',
    ])
  })

  it('defaults to receivedAt desc', async () => {
    const res = await api(app, owner, { method: 'GET', url: '/api/v1/leads' })
    expect(res.json().items[0].name).toBe('Hot Harriet')
  })
})

describe('aggregates', () => {
  it('reflect the whole workspace when unfiltered', async () => {
    const res = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=200' })
    const { aggregates, items } = res.json()
    expect(aggregates.total).toBe(8)
    expect(aggregates.countByStage).toEqual({
      New: 2,
      Contacted: 1,
      Qualified: 1,
      'Proposal sent': 1,
      'Closed won': 1,
      'Closed lost': 1,
      'Not fit': 1,
    })
    expect(aggregates.countByTier).toEqual({ hot: 3, warm: 2, cold: 3 })
    expect(aggregates.wonCount).toBe(1)
    expect(aggregates.wonValue).toBe(15000)
    expect(aggregates.overdueCount).toBe(1)
    expect(aggregates.unassignedCount).toBe(3)
    expect(aggregates.needsAttentionCount).toBe(5)

    // pipelineExpectedValue = Σ expectedValue over non-closed items, self-consistent with the list.
    const closed = ['Closed won', 'Closed lost', 'Not fit']
    const expected = items
      .filter((item: { stage: string }) => !closed.includes(item.stage))
      .reduce((sum: number, item: { expectedValue: number }) => sum + item.expectedValue, 0)
    expect(aggregates.pipelineExpectedValue).toBeCloseTo(expected, 2)
  })

  it('are computed under the active filters', async () => {
    const res = await api(app, owner, { method: 'GET', url: '/api/v1/leads?stage=New' })
    const { aggregates } = res.json()
    expect(aggregates.total).toBe(2)
    expect(aggregates.countByStage).toEqual({ New: 2 })
    expect(aggregates.unassignedCount).toBe(2)
  })
})

describe('CSV export', () => {
  it('respects filters and escapes safely', async () => {
    const res = await api(app, owner, { method: 'GET', url: '/api/v1/leads/export.csv?tier=hot' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('attachment')
    const lines = res.body.trim().split('\r\n')
    expect(lines[0]).toMatch(/^id,receivedAt,name/)
    expect(lines).toHaveLength(4) // header + 3 hot leads
    expect(res.body).toContain('Hot Harriet')
  })
})

describe('analytics', () => {
  it('returns funnel, win rate, values, trends and calibration', async () => {
    const res = await api(app, owner, { method: 'GET', url: '/api/v1/analytics' })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.totalLeads).toBe(8)
    expect(body.wonCount).toBe(1)
    expect(body.lostCount).toBe(1)
    expect(body.winRate).toBe(0.5)
    expect(body.totalWonValue).toBe(15000)
    expect(body.avgDealSize).toBe(15000)

    const funnelMap = Object.fromEntries(
      body.funnel.map((row: { stage: string; count: number }) => [row.stage, row.count]),
    )
    expect(funnelMap.New).toBe(2)
    expect(funnelMap['Closed won']).toBe(1)

    expect(body.leadsPerWeek.reduce((sum: number, row: { count: number }) => sum + row.count, 0)).toBe(8)
    expect(body.expectedPipelineTrend.length).toBeGreaterThan(0)

    const band910 = body.scoreCalibration.find((row: { band: string }) => row.band === '9-10')
    expect(band910.count).toBe(2) // Harriet + Wendy
    expect(band910.won).toBe(1)
    expect(band910.winRate).toBe(1)
    const band34 = body.scoreCalibration.find((row: { band: string }) => row.band === '3-4')
    expect(band34.count).toBe(2) // Larry + Oliver
    expect(band34.winRate).toBe(0)

    // Reply events exist (Wanda, Petra) → a first-response average is computable.
    expect(body.firstResponse.avgHours).toBeGreaterThan(0)
    expect(body.firstResponse.trend.length).toBeGreaterThan(0)

    const emailRow = body.sourcePerformance.find((row: { source: string }) => row.source === 'Email')
    expect(emailRow.count).toBe(3)

    // Range filter: exclude everything → empty analytics, no crash.
    const empty = await api(app, owner, {
      method: 'GET',
      url: `/api/v1/analytics?from=${daysFromNow(1)}&to=${daysFromNow(2)}`,
    })
    expect(empty.statusCode).toBe(200)
    expect(empty.json().totalLeads).toBe(0)
    expect(empty.json().winRate).toBeNull()
  })
})
