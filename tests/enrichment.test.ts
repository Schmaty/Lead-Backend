import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { InboundEmail } from '../src/modules/pipeline/mailbox.js'
import { runScan, type ScanDeps } from '../src/modules/pipeline/scanner.js'
import type { ConversationContext, ScoredLead } from '../src/modules/pipeline/scorer.js'
import type { AmbientInsight, AmbientMeeting } from '../src/services/ambient.js'
import { clearZohoTokenCacheForTesting, setZohoDepsForTesting } from '../src/services/zoho.js'
import { api, makeApp, resetDb, signup, testConfig, type Session } from './helpers.js'

const OWNER_EMAIL = 'owner@enrich.test'
const MAILBOX = 'inbox@enrich.test'
const ENV = { DEVELOPER_EMAILS: OWNER_EMAIL }

let app: FastifyInstance
let owner: Session

const email = (overrides: Partial<InboundEmail> & { messageId: string }): InboundEmail => ({
  from: { name: 'Someone', address: 'someone@example.test' },
  to: [MAILBOX],
  subject: '(no subject)',
  date: new Date('2026-07-15T10:00:00Z'),
  text: '',
  references: [],
  inReplyTo: null,
  ...overrides,
})

const jordanEmail = email({
  messageId: '<enq-1@client.example>',
  from: { name: 'Jordan Wells', address: 'jordan@client.example' },
  subject: 'Workshop for our team',
  text: 'Interested in a workshop for 20 people.',
})
const miaEmail = email({
  messageId: '<enq-2@client.example>',
  from: { name: 'Mia Chen', address: 'mia@client.example' },
  subject: 'Re: Workshop for our team',
  date: new Date('2026-07-15T14:00:00Z'),
  text: 'Adding our COO Mia here — she owns the budget.',
  references: ['<enq-1@client.example>'],
  inReplyTo: '<enq-1@client.example>',
})

const scoredJordan: ScoredLead = {
  relevant: true,
  name: 'Jordan Wells',
  org: 'Client Example Inc',
  inquiryType: 'Training request',
  summary: 'Wants a 20-person workshop.',
  fitScore: 8,
  urgencyScore: 6,
  leadScore: 8,
  dealValueLow: 4000,
  dealValueHigh: 8000,
  estPayoutRaw: '$4–8k',
  estWork: '~1 day',
  recommendedNextStep: 'Offer a scoping call.',
  draftReply: 'Hi Jordan…',
  fitReasons: ['Core offering'],
  riskFlags: [],
  inferredFields: [],
}

interface Options {
  sent?: InboundEmail[]
  meetings?: AmbientMeeting[]
  insights?: Record<string, AmbientInsight>
  scoreCalls?: Array<{ messageId: string; context?: ConversationContext; model?: string }>
}

function deps(emails: InboundEmail[], options: Options = {}): ScanDeps {
  return {
    fetchEmails: async () => emails,
    fetchSentEmails: async () => options.sent ?? [],
    scoreEmail: async (_key, incoming, _settings, _name, context, model) => {
      options.scoreCalls?.push({ messageId: incoming.messageId, context, model })
      return { ...scoredJordan, summary: `scored:${incoming.messageId}` }
    },
    listMeetings: async () => options.meetings ?? [],
    getMeetingInsight: async (_config, insightId) => options.insights?.[insightId] ?? { tldr: '', text: '' },
    classifyEmail: async () => ({ decision: 'unsure' as const, confidence: 0.5, reason: 'test default' }),
  }
}

async function leadDetail(): Promise<Record<string, any>> {
  const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })
  const lead = list.json().items.find((l: { externalId: string }) => l.externalId === jordanEmail.messageId)
  return (await api(app, owner, { method: 'GET', url: `/api/v1/leads/${lead.id}` })).json()
}

beforeAll(async () => {
  app = await makeApp(ENV)
  await resetDb(app)
  owner = await signup(app, { email: OWNER_EMAIL, workspaceName: 'Enrich Co' })
  await api(app, owner, {
    method: 'PUT',
    url: '/api/v1/workspace/credentials/GMAIL_IMAP',
    payload: { value: 'app-password-0001', meta: { email: MAILBOX } },
  })
  await api(app, owner, {
    method: 'PUT',
    url: '/api/v1/platform/credentials/ANTHROPIC_API_KEY',
    payload: { value: 'sk-ant-test-enrich-0001' },
  })
})

afterAll(async () => {
  await app.close()
})

describe('person profiles', () => {
  it('the sender becomes a person ("Reached out") with their messages attached', async () => {
    await runScan(app.prisma, testConfig(ENV), owner.workspace.id, deps([jordanEmail]))
    const detail = await leadDetail()
    expect(detail.people).toHaveLength(1)
    expect(detail.people[0]).toMatchObject({ name: 'Jordan Wells', email: 'jordan@client.example', role: 'Reached out' })
    expect(detail.threads[0].personId).toBe(detail.people[0].id)
  })

  it('a second correspondent in the thread becomes their own person', async () => {
    await runScan(app.prisma, testConfig(ENV), owner.workspace.id, deps([miaEmail]))
    const detail = await leadDetail()
    expect(detail.people).toHaveLength(2)
    const mia = detail.people.find((p: { email: string }) => p.email === 'mia@client.example')
    expect(mia.name).toBe('Mia Chen') // the sender's own name, not the lead's primary contact
    const miaThread = detail.threads.find((t: { url: string }) => t.url.includes(encodeURIComponent('<enq-2@client.example>')))
    expect(miaThread.personId).toBe(mia.id)
  })

  it('our sent replies attach to the person they were sent to', async () => {
    const reply = email({
      messageId: '<out-enq-1@enrich.test>',
      from: { name: 'Enrich', address: MAILBOX },
      to: ['jordan@client.example'],
      subject: 'Re: Workshop for our team',
      date: new Date('2026-07-15T16:00:00Z'),
      references: ['<enq-1@client.example>'],
      text: 'Happy to help!',
    })
    const result = await runScan(app.prisma, testConfig(ENV), owner.workspace.id, deps([], { sent: [reply] }))
    expect(result.replies).toBe(1)
    const detail = await leadDetail()
    const out = detail.threads.find((t: { direction: string }) => t.direction === 'out')
    const jordan = detail.people.find((p: { email: string }) => p.email === 'jordan@client.example')
    expect(out.personId).toBe(jordan.id)
  })
})

describe('meeting enrichment (transcript provider)', () => {
  const meeting: AmbientMeeting = {
    id: 'mtg_test_1',
    title: 'Scoping call — Client Example',
    startsAt: new Date('2026-07-15T18:00:00Z'),
    endsAt: new Date('2026-07-15T18:30:00Z'),
    attendees: [
      { email: 'jordan@client.example', name: 'Jordan Wells', organizer: false },
      { email: 'sasha@client.example', name: 'Sasha Ito', organizer: false },
      { email: MAILBOX, name: 'Enrich', organizer: true },
    ],
    insightId: 'ins_test_1',
    insightUrl: 'https://app.ambient.example/dossier/1',
  }
  const insights = { ins_test_1: { tldr: 'Budget confirmed at $10k; decision by Friday.', text: '## Dossier\nDetails…' } }

  it('does nothing until the developer connects the provider', async () => {
    const result = await runScan(app.prisma, testConfig(ENV), owner.workspace.id, deps([], { meetings: [meeting], insights }))
    expect(result.meetings).toBe(0)
  })

  it('attaches meetings to leads by attendee email, with dossier, people, and timeline', async () => {
    const put = await api(app, owner, {
      method: 'PUT',
      url: '/api/v1/platform/credentials/AMBIENT_API_KEY',
      payload: { value: 'amb_test_key_0001', meta: { baseUrl: 'https://api.ambient.example/v1' } },
    })
    expect(put.statusCode).toBe(200)

    const result = await runScan(app.prisma, testConfig(ENV), owner.workspace.id, deps([], { meetings: [meeting], insights }))
    expect(result.meetings).toBe(1)

    const detail = await leadDetail()
    expect(detail.meetings).toHaveLength(1)
    expect(detail.meetings[0]).toMatchObject({
      title: 'Scoping call — Client Example',
      tldr: 'Budget confirmed at $10k; decision by Friday.',
      url: 'https://app.ambient.example/dossier/1',
    })
    expect(detail.timeline.some((e: { type: string }) => e.type === 'meeting')).toBe(true)
    // The extra attendee joined the people profile.
    const sasha = detail.people.find((p: { email: string }) => p.email === 'sasha@client.example')
    expect(sasha).toMatchObject({ name: 'Sasha Ito', role: 'Meeting attendee' })
  })

  it('is idempotent per meeting per lead', async () => {
    const again = await runScan(app.prisma, testConfig(ENV), owner.workspace.id, deps([], { meetings: [meeting], insights }))
    expect(again.meetings).toBe(0)
    const detail = await leadDetail()
    expect(detail.meetings).toHaveLength(1)
  })

  it('feeds meeting intel into the next conversation re-score', async () => {
    const followUp = email({
      messageId: '<enq-3@client.example>',
      from: { name: 'Jordan Wells', address: 'jordan@client.example' },
      subject: 'Re: Workshop for our team',
      date: new Date('2026-07-16T09:00:00Z'),
      references: ['<enq-1@client.example>'],
      text: 'Following up after our call.',
    })
    const scoreCalls: Options['scoreCalls'] = []
    await runScan(app.prisma, testConfig(ENV), owner.workspace.id, deps([followUp], { scoreCalls }))
    expect(scoreCalls).toHaveLength(1)
    expect(scoreCalls[0]!.context?.meetings?.[0]?.tldr).toContain('$10k')
  })
})

describe('scorer model picker', () => {
  it('defaults to opus and rejects unknown models', async () => {
    const bad = await api(app, owner, {
      method: 'PATCH',
      url: '/api/v1/platform/credentials/ANTHROPIC_API_KEY',
      payload: { meta: { model: 'claude-nonsense-9' } },
    })
    expect(bad.statusCode).toBe(400)

    const scoreCalls: Options['scoreCalls'] = []
    await runScan(
      app.prisma,
      testConfig(ENV),
      owner.workspace.id,
      deps([email({ messageId: '<model-a@x.example>', from: { name: 'A', address: 'a@x.example' }, subject: 'Hi' })], { scoreCalls }),
    )
    expect(scoreCalls[0]!.model).toBe('claude-opus-4-8')
  })

  it('a developer-picked model flows through to scoring', async () => {
    const patch = await api(app, owner, {
      method: 'PATCH',
      url: '/api/v1/platform/credentials/ANTHROPIC_API_KEY',
      payload: { meta: { model: 'claude-haiku-4-5' } },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().meta.model).toBe('claude-haiku-4-5')

    const scoreCalls: Options['scoreCalls'] = []
    await runScan(
      app.prisma,
      testConfig(ENV),
      owner.workspace.id,
      deps([email({ messageId: '<model-b@x.example>', from: { name: 'B', address: 'b@x.example' }, subject: 'Hello' })], { scoreCalls }),
    )
    expect(scoreCalls[0]!.model).toBe('claude-haiku-4-5')
  })
})

describe('Zoho CRM', () => {
  it('reports unavailable before the developer connects Zoho', async () => {
    const detail = await leadDetail()
    const res = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${detail.id}/crm` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ available: false, records: [], push: { comingSoon: true } })
  })

  it('requires meta.clientId on the ZOHO_CRM credential', async () => {
    const res = await api(app, owner, {
      method: 'PUT',
      url: '/api/v1/platform/credentials/ZOHO_CRM',
      payload: { value: JSON.stringify({ clientSecret: 's', refreshToken: 'r' }) },
    })
    expect(res.statusCode).toBe(400)
  })

  it('looks up CRM records for the lead and its people, read-only', async () => {
    const put = await api(app, owner, {
      method: 'PUT',
      url: '/api/v1/platform/credentials/ZOHO_CRM',
      payload: {
        value: JSON.stringify({ clientSecret: 'zoho-secret', refreshToken: 'zoho-refresh' }),
        meta: { clientId: 'zoho-client-id-0001' },
      },
    })
    expect(put.statusCode).toBe(200)

    clearZohoTokenCacheForTesting()
    const requested: string[] = []
    const restore = setZohoDepsForTesting({
      async fetchJson(url) {
        requested.push(url)
        if (url.includes('/oauth/v2/token')) {
          return { status: 200, json: { access_token: 'zoho-access-1', expires_in: 3600 } }
        }
        if (url.includes('/Leads/search') && url.includes('jordan%40client.example')) {
          return {
            status: 200,
            json: { data: [{ id: 'z-101', First_Name: 'Jordan', Last_Name: 'Wells', Email: 'jordan@client.example', Company: 'Client Example Inc' }] },
          }
        }
        return { status: 204, json: null }
      },
    })
    try {
      const detail = await leadDetail()
      const res = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${detail.id}/crm` })
      expect(res.statusCode).toBe(200)
      expect(res.json().available).toBe(true)
      expect(res.json().records).toHaveLength(1)
      expect(res.json().records[0]).toMatchObject({
        module: 'Leads',
        name: 'Jordan Wells',
        company: 'Client Example Inc',
        url: 'https://crm.zoho.com/crm/tab/Leads/z-101',
      })
      // It searched with the lead's email AND the people's emails.
      expect(requested.some((u) => u.includes('mia%40client.example'))).toBe(true)
    } finally {
      restore()
    }
  })

  it('the CRM pull runs inside every scan: caches matches, logs them, fills phones', async () => {
    // Reset the cache so the scan's stale-lead sweep picks this lead up.
    const detail0 = await leadDetail()
    await app.prisma.lead.update({ where: { id: detail0.id }, data: { crmCheckedAt: null } })

    clearZohoTokenCacheForTesting()
    const restore = setZohoDepsForTesting({
      async fetchJson(url) {
        if (url.includes('/oauth/v2/token')) return { status: 200, json: { access_token: 'zoho-access-2', expires_in: 3600 } }
        if (url.includes('/Contacts/search') && url.includes('jordan%40client.example')) {
          return {
            status: 200,
            json: { data: [{ id: 'z-201', First_Name: 'Jordan', Last_Name: 'Wells', Email: 'jordan@client.example', Phone: '+1 555 0100', Account_Name: { name: 'Client Example Inc' } }] },
          }
        }
        return { status: 204, json: null }
      },
    })
    try {
      const result = await runScan(app.prisma, testConfig(ENV), owner.workspace.id, deps([]))
      expect(result.crm).toBe(1)

      const detail = await leadDetail()
      expect(detail.crmCheckedAt).toBeTruthy()
      expect(detail.crmRecords.some((r: { id: string }) => r.id === 'z-201')).toBe(true)
      expect(detail.timeline.some((e: { type: string }) => e.type === 'crm_match')).toBe(true)
      const jordan = detail.people.find((p: { email: string }) => p.email === 'jordan@client.example')
      expect(jordan.phone).toBe('+1 555 0100')

      // Second scan: already checked and untouched → no repeat Zoho traffic counted.
      const again = await runScan(app.prisma, testConfig(ENV), owner.workspace.id, deps([]))
      expect(again.crm).toBe(0)
    } finally {
      restore()
    }
  })

  it('the one-shot import pulls open Zoho leads in and auto-categorizes them', async () => {
    clearZohoTokenCacheForTesting()
    const restore = setZohoDepsForTesting({
      async fetchJson(url) {
        if (url.includes('/oauth/v2/token')) return { status: 200, json: { access_token: 'zoho-access-3', expires_in: 3600 } }
        if (url.includes('/crm/v8/Leads?fields=')) {
          return {
            status: 200,
            json: { data: [{ id: 'z-500', First_Name: 'Sky', Last_Name: 'Tanaka', Email: 'sky@newco.example', Company: 'NewCo', Phone: '+1 555 0200', Description: 'Met at conference; wants AI training.', Lead_Status: 'Open' }] },
          }
        }
        return { status: 204, json: null }
      },
    })
    try {
      const result = await runScan(app.prisma, testConfig(ENV), owner.workspace.id, deps([]), { deep: true })
      expect(result.imported).toBe(1)
      expect(result.errors).toEqual([])
    } finally {
      restore()
    }
    const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })
    const imported = list.json().items.find((l: { externalId: string | null }) => l.externalId === 'zoho:z-500')
    expect(imported.source).toBe('CRM import')
    expect(imported.email).toBe('sky@newco.example')
    // Re-import is idempotent — the lead already exists by email.
    const again = await runScan(app.prisma, testConfig(ENV), owner.workspace.id, deps([]), { deep: true })
    expect(again.imported).toBe(0)
  })

  it('push to CRM is built but gated: 501 coming soon', async () => {
    const detail = await leadDetail()
    const res = await api(app, owner, { method: 'POST', url: `/api/v1/leads/${detail.id}/crm/push` })
    expect(res.statusCode).toBe(501)
    expect(res.json().comingSoon).toBe(true)
  })
})
