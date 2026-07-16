import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { InboundEmail, MailboxConfig } from '../src/modules/pipeline/mailbox.js'
import { runScan, setScanDepsForTesting, type ScanDeps } from '../src/modules/pipeline/scanner.js'
import { normalizeScoredLead, type ScoredLead } from '../src/modules/pipeline/scorer.js'
import { DEFAULT_SETTINGS } from '../src/types/settings.js'
import { addMember, api, makeApp, resetDb, signup, testConfig, type Session } from './helpers.js'

const MAILBOX_ADDRESS = 'inbox@fieldstone.example'

const hotEmail: InboundEmail = {
  messageId: '<hot-1@mail.example>',
  from: { name: 'Dana Okafor', address: 'dana@northwind.example' },
  subject: 'AI training for our ops team',
  date: new Date('2026-07-15T10:00:00Z'),
  text: 'We want a 40-seat AI workshop, budget approved, starting next month.',
}
const spamEmail: InboundEmail = {
  messageId: '<spam-1@mail.example>',
  from: { name: 'MegaDeals', address: 'noreply@megadeals.example' },
  subject: 'HOT SUMMER DEALS INSIDE',
  date: new Date('2026-07-15T11:00:00Z'),
  text: 'Buy now! Unsubscribe here.',
}
const selfEmail: InboundEmail = {
  messageId: '<self-1@mail.example>',
  from: { name: 'Me', address: MAILBOX_ADDRESS },
  subject: 'Note to self',
  date: new Date('2026-07-15T12:00:00Z'),
  text: 'remember the thing',
}

const scoredFor: Record<string, ScoredLead> = {
  [hotEmail.messageId]: {
    relevant: true,
    name: 'Dana Okafor',
    org: 'Northwind Logistics',
    inquiryType: 'Training request',
    summary: 'VP wants a 40-seat AI workshop with approved budget.',
    fitScore: 9,
    urgencyScore: 8,
    leadScore: 9,
    dealValueLow: 6000,
    dealValueHigh: 12000,
    estPayoutRaw: '$6,000–12,000 — 40 seats, budget approved',
    estWork: '~2 workshop days + prep',
    recommendedNextStep: 'Offer a scoping call this week.',
    draftReply: 'Hi Dana — happy to help…',
    fitReasons: ['Budget approved', 'Named headcount'],
    riskFlags: [],
    inferredFields: ['dealValueLow', 'dealValueHigh'],
  },
  [spamEmail.messageId]: {
    relevant: false,
    name: 'MegaDeals',
    org: 'MegaDeals',
    inquiryType: 'Other',
    summary: 'Promotional newsletter, not an inquiry.',
    fitScore: 0,
    urgencyScore: 0,
    leadScore: 1,
    dealValueLow: 0,
    dealValueHigh: 0,
    estPayoutRaw: '',
    estWork: '',
    recommendedNextStep: 'Ignore.',
    draftReply: '',
    fitReasons: [],
    riskFlags: ['Bulk promotional mail'],
    inferredFields: [],
  },
}

function fakeDeps(emails: InboundEmail[], sinceLog: Date[] = []): ScanDeps {
  return {
    fetchEmails: async (_config: MailboxConfig, since: Date) => {
      sinceLog.push(since)
      return emails
    },
    scoreEmail: async (_apiKey, email) => {
      const scored = scoredFor[email.messageId]
      if (!scored) throw new Error(`no fake score for ${email.messageId}`)
      return scored
    },
  }
}

let app: FastifyInstance
let owner: Session
let member: Session

beforeAll(async () => {
  // The owner doubles as the platform developer: GMAIL_IMAP (fallback path)
  // and the universal Anthropic key are developer-managed.
  app = await makeApp({ DEVELOPER_EMAILS: 'owner@pipeline.test' })
  await resetDb(app)
  owner = await signup(app, { email: 'owner@pipeline.test', workspaceName: 'Pipeline Co' })
  member = await addMember(app, owner, 'member@pipeline.test')
})

afterAll(async () => {
  await app.close()
})

describe('scan configuration and permissions', () => {
  it('reports unconfigured and refuses to scan before credentials exist', async () => {
    const status = await api(app, owner, { method: 'GET', url: '/api/v1/workspace/scan/status' })
    expect(status.statusCode).toBe(200)
    expect(status.json().configured).toBe(false)

    const scan = await api(app, owner, { method: 'POST', url: '/api/v1/workspace/scan' })
    expect(scan.statusCode).toBe(400)
    expect(scan.json().error).toMatch(/not configured/i)
  })

  it('MEMBERs cannot trigger scans', async () => {
    const res = await api(app, member, { method: 'POST', url: '/api/v1/workspace/scan' })
    expect(res.statusCode).toBe(403)
  })

  it('arms via the GMAIL_IMAP fallback plus the platform Anthropic key', async () => {
    const gmail = await api(app, owner, {
      method: 'PUT',
      url: '/api/v1/workspace/credentials/GMAIL_IMAP',
      payload: { value: 'gmail-app-password-0001', meta: { email: MAILBOX_ADDRESS } },
    })
    expect(gmail.statusCode).toBe(200)

    // AI key is universal — one platform credential covers every workspace.
    const anthropic = await api(app, owner, {
      method: 'PUT',
      url: '/api/v1/platform/credentials/ANTHROPIC_API_KEY',
      payload: { value: 'sk-ant-test-not-real-0001' },
    })
    expect(anthropic.statusCode).toBe(200)

    const status = await api(app, owner, { method: 'GET', url: '/api/v1/workspace/scan/status' })
    expect(status.json().configured).toBe(true)
    expect(status.json().method).toBe('imap')
    expect(status.json().email).toBe(MAILBOX_ADDRESS)
    expect(status.json().aiReady).toBe(true)
    expect(status.json().googleSignInAvailable).toBe(false)
    expect(status.json().lastScanAt).toBeNull()
  })

  it('retired workspace credential kinds are no longer accepted', async () => {
    for (const kind of ['GOOGLE_SHEET', 'ANTHROPIC_API_KEY']) {
      const res = await api(app, owner, {
        method: 'PUT',
        url: `/api/v1/workspace/credentials/${kind}`,
        payload: { value: 'whatever' },
      })
      expect(res.statusCode).toBe(400)
    }
  })
})

describe('runScan', () => {
  it('scores new mail into leads, routes irrelevant mail to Spam, skips own address', async () => {
    const result = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([hotEmail, spamEmail, selfEmail]))
    expect(result.scanned).toBe(3)
    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(1) // the workspace's own outbound mail
    expect(result.errors).toEqual([])

    const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })
    expect(list.json().total).toBe(2)

    const hot = list.json().items.find((l: { externalId: string }) => l.externalId === hotEmail.messageId)
    expect(hot.name).toBe('Dana Okafor')
    expect(hot.source).toBe('Email')
    expect(hot.tier).toBe('hot') // leadScore 9 with default thresholds
    expect(hot.winProbability).toBe(0.55)
    expect(hot.expectedValue).toBe(4950)
    expect(hot.stage).toBe('New')

    const spam = list.json().items.find((l: { externalId: string }) => l.externalId === spamEmail.messageId)
    expect(spam.stage).toBe('Spam')

    const detail = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${hot.id}` })
    expect(detail.json().threads).toHaveLength(1)
    expect(detail.json().threads[0].url).toContain('rfc822msgid')
    expect(detail.json().timeline[0].actor).toBe('system')
    expect(detail.json().timeline[0].detail).toContain('Scanned from inbox')
  })

  it('is idempotent: re-scanning the same mail updates instead of duplicating', async () => {
    const result = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([hotEmail, spamEmail]))
    expect(result.imported).toBe(0)
    expect(result.updated).toBe(2)

    const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })
    expect(list.json().total).toBe(2)
  })

  it('human edits survive re-scans', async () => {
    const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })
    const hot = list.json().items.find((l: { externalId: string }) => l.externalId === hotEmail.messageId)
    await api(app, owner, {
      method: 'PATCH',
      url: `/api/v1/leads/${hot.id}`,
      payload: { stage: 'Contacted', notes: 'called them' },
    })

    await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([hotEmail]))

    const after = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${hot.id}` })
    expect(after.json().stage).toBe('Contacted')
    expect(after.json().notes).toBe('called them')
  })

  it('advances the scan cursor and re-reads with an overlap window', async () => {
    const status = await api(app, owner, { method: 'GET', url: '/api/v1/workspace/scan/status' })
    const lastScanAt = new Date(status.json().lastScanAt)
    expect(Number.isNaN(lastScanAt.getTime())).toBe(false)

    const sinceLog: Date[] = []
    await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([], sinceLog))
    expect(sinceLog).toHaveLength(1)
    expect(sinceLog[0]!.getTime()).toBeLessThan(lastScanAt.getTime()) // overlap
    expect(sinceLog[0]!.getTime()).toBeGreaterThan(lastScanAt.getTime() - 2 * 3600 * 1000)
  })

  it('a scoring failure skips that email and reports it, without failing the scan', async () => {
    const broken: InboundEmail = { ...hotEmail, messageId: '<broken-1@mail.example>', subject: 'Breaks scoring' }
    const result = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([broken]))
    expect(result.imported).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Breaks scoring')
  })
})

describe('scan route flow', () => {
  it('POST /scan runs in the background and status reports the result', async () => {
    const restore = setScanDepsForTesting(fakeDeps([hotEmail, spamEmail]))
    try {
      const kick = await api(app, owner, { method: 'POST', url: '/api/v1/workspace/scan' })
      expect(kick.statusCode).toBe(202)

      let status
      for (let i = 0; i < 50; i++) {
        const res = await api(app, owner, { method: 'GET', url: '/api/v1/workspace/scan/status' })
        status = res.json()
        if (!status.running && status.lastResult) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(status.lastResult.scanned).toBe(2)
      expect(status.lastResult.updated).toBe(2)
      expect(status.lastError).toBeNull()
    } finally {
      restore()
    }
  })
})

describe('normalizeScoredLead', () => {
  const base = scoredFor[hotEmail.messageId]!

  it('clamps out-of-list inquiry types to a configured category', () => {
    const out = normalizeScoredLead({ ...base, inquiryType: 'Something Claude invented' }, DEFAULT_SETTINGS)
    expect(out.inquiryType).toBe('Other')
    const caseFix = normalizeScoredLead({ ...base, inquiryType: 'training request' }, DEFAULT_SETTINGS)
    expect(caseFix.inquiryType).toBe('Training request')
  })

  it('reorders swapped deal values and clamps scores', () => {
    const out = normalizeScoredLead(
      { ...base, dealValueLow: 9000, dealValueHigh: 2000, leadScore: 14 as number, fitScore: -2 as number },
      DEFAULT_SETTINGS,
    )
    expect(out.dealValueLow).toBe(2000)
    expect(out.dealValueHigh).toBe(9000)
    expect(out.leadScore).toBe(10)
    expect(out.fitScore).toBe(0)
  })
})
