import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { InboundEmail, MailboxConfig } from '../src/modules/pipeline/mailbox.js'
import { runScan, setScanDepsForTesting, type ScanDeps } from '../src/modules/pipeline/scanner.js'
import { normalizeScoredLead, type ConversationContext, type RelevanceVerdict, type ScoredLead } from '../src/modules/pipeline/scorer.js'
import type { AmbientInsight, AmbientMeeting } from '../src/services/ambient.js'
import { DEFAULT_SETTINGS } from '../src/types/settings.js'
import { addMember, api, makeApp, resetDb, signup, testConfig, type Session } from './helpers.js'

const MAILBOX_ADDRESS = 'inbox@fieldstone.example'

const email = (overrides: Partial<InboundEmail> & { messageId: string }): InboundEmail => ({
  from: { name: 'Someone', address: 'someone@example.test' },
  to: [MAILBOX_ADDRESS],
  subject: '(no subject)',
  date: new Date('2026-07-15T10:00:00Z'),
  text: '',
  references: [],
  inReplyTo: null,
  ...overrides,
})

const hotEmail = email({
  messageId: '<hot-1@mail.example>',
  from: { name: 'Dana Okafor', address: 'dana@northwind.example' },
  subject: 'AI training for our ops team',
  date: new Date('2026-07-15T10:00:00Z'),
  text: 'We want a 40-seat AI workshop, budget approved, starting next month.',
})
const spamEmail = email({
  messageId: '<spam-1@mail.example>',
  from: { name: 'MegaDeals', address: 'noreply@megadeals.example' },
  subject: 'HOT SUMMER DEALS INSIDE',
  date: new Date('2026-07-15T11:00:00Z'),
  text: 'Buy now! Unsubscribe here.',
})
const selfEmail = email({
  messageId: '<self-1@mail.example>',
  from: { name: 'Me', address: MAILBOX_ADDRESS },
  subject: 'Note to self',
  date: new Date('2026-07-15T12:00:00Z'),
  text: 'remember the thing',
})

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

interface FakeDepOptions {
  sent?: InboundEmail[]
  /** Per-message gate verdicts; default escalates everything to the full scorer. */
  gate?: Record<string, RelevanceVerdict>
  gateCalls?: string[]
  sinceLog?: Date[]
  meetings?: AmbientMeeting[]
  insights?: Record<string, AmbientInsight>
  /** Records every scoring call: which email, with what conversation context and model. */
  scoreCalls?: Array<{ messageId: string; context?: ConversationContext; model?: string }>
}

function fakeDeps(emails: InboundEmail[], options: FakeDepOptions = {}): ScanDeps {
  return {
    fetchEmails: async (_config: MailboxConfig, since: Date) => {
      options.sinceLog?.push(since)
      return emails
    },
    fetchSentEmails: async () => options.sent ?? [],
    scoreEmail: async (_apiKey, email, _settings, _workspaceName, context, model) => {
      options.scoreCalls?.push({ messageId: email.messageId, context, model })
      const scored = scoredFor[email.messageId]
      if (!scored) throw new Error(`no fake score for ${email.messageId}`)
      return scored
    },
    listMeetings: async () => options.meetings ?? [],
    getMeetingInsight: async (_config, insightId) => options.insights?.[insightId] ?? { tldr: '', text: '' },
    classifyEmail: async (_apiKey, email) => {
      options.gateCalls?.push(email.messageId)
      return options.gate?.[email.messageId] ?? { decision: 'unsure', confidence: 0.5, reason: 'test default' }
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
  it('imports real inquiries, never admits spam, skips own address', async () => {
    const result = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([hotEmail, spamEmail, selfEmail]))
    expect(result.scanned).toBe(3)
    expect(result.imported).toBe(1)
    expect(result.ignored).toBe(1) // the newsletter — never becomes a lead
    expect(result.skipped).toBe(1) // the workspace's own outbound mail
    expect(result.errors).toEqual([])

    // Spam is logged to the ignore list, not the lead table.
    const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })
    expect(list.json().total).toBe(1)
    const remembered = await app.prisma.ignoredThread.findUnique({
      where: { workspaceId_threadKey: { workspaceId: owner.workspace.id, threadKey: spamEmail.messageId } },
    })
    expect(remembered?.fromAddress).toBe('noreply@megadeals.example')

    const hot = list.json().items.find((l: { externalId: string }) => l.externalId === hotEmail.messageId)
    expect(hot.name).toBe('Dana Okafor')
    expect(hot.source).toBe('Email')
    expect(hot.tier).toBe('hot') // leadScore 9 with default thresholds
    expect(hot.winProbability).toBe(0.55)
    expect(hot.expectedValue).toBe(4950)
    expect(hot.stage).toBe('New')

    const detail = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${hot.id}` })
    expect(detail.json().threads).toHaveLength(1)
    expect(detail.json().threads[0].url).toContain('rfc822msgid')
    expect(detail.json().timeline[0].actor).toBe('system')
    expect(detail.json().timeline[0].detail).toContain('Scanned from inbox')
  })

  it('is idempotent: known mail and remembered spam spend no AI calls', async () => {
    const scoreCalls: Array<{ messageId: string; context?: ConversationContext }> = []
    const result = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([hotEmail, spamEmail], { scoreCalls }))
    expect(result.imported).toBe(0)
    expect(result.updated).toBe(1) // hot thread already stored
    expect(result.ignored).toBe(1) // spam remembered from last scan
    // No re-scoring for either — the ignore list is the token saver.
    expect(scoreCalls).toHaveLength(0)

    const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })
    expect(list.json().total).toBe(1)
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
    await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([], { sinceLog }))
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
  it('reports live per-email progress while a scan runs', async () => {
    const slowDeps: ScanDeps = {
      fetchEmails: async () => [hotEmail, spamEmail],
      fetchSentEmails: async () => [],
      scoreEmail: async (_key, email) => {
        await new Promise((resolve) => setTimeout(resolve, 250))
        return scoredFor[email.messageId]!
      },
      listMeetings: async () => [],
      getMeetingInsight: async () => ({ tldr: '', text: '' }),
      classifyEmail: async () => ({ decision: 'unsure', confidence: 0.5, reason: 'slow test' }),
    }
    const restore = setScanDepsForTesting(slowDeps)
    try {
      const kick = await api(app, owner, { method: 'POST', url: '/api/v1/workspace/scan' })
      expect(kick.statusCode).toBe(202)

      let sawProgress = false
      for (let i = 0; i < 100; i++) {
        const res = await api(app, owner, { method: 'GET', url: '/api/v1/workspace/scan/status' })
        const status = res.json()
        if (status.running && status.progress?.phase === 'scoring') {
          sawProgress = true
          expect(status.progress.total).toBe(2)
          expect(status.progress.processed).toBeLessThanOrEqual(2)
        }
        if (!status.running && status.lastResult) {
          // Progress is only exposed while running.
          expect(status.progress).toBeNull()
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      expect(sawProgress).toBe(true)
    } finally {
      restore()
    }
  })

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
      expect(status.lastResult.updated).toBe(1)
      expect(status.lastResult.ignored).toBe(1)
      expect(status.lastError).toBeNull()
    } finally {
      restore()
    }
  })
})

describe('conversation merging & progress tracking', () => {
  const danaReply = email({
    messageId: '<hot-2@mail.example>',
    from: { name: 'Dana Okafor', address: 'dana@northwind.example' },
    subject: 'Re: AI training for our ops team',
    date: new Date('2026-07-16T09:00:00Z'),
    text: 'Great — the 22nd works. Can you send a proposal for the 40 seats?',
    references: ['<hot-1@mail.example>'],
    inReplyTo: '<hot-1@mail.example>',
  })
  const patFirst = email({
    messageId: '<pat-1@mail.example>',
    from: { name: 'Pat Ibarra', address: 'pat@harborlight.example' },
    subject: 'Team enablement help',
    date: new Date('2026-07-16T10:00:00Z'),
    text: 'Looking for AI enablement for a 12-person team.',
  })
  const patSecond = email({
    messageId: '<pat-2@mail.example>',
    from: { name: 'Pat Ibarra', address: 'pat@harborlight.example' },
    subject: 'Re: Team enablement help',
    date: new Date('2026-07-16T10:30:00Z'),
    text: 'Forgot to add: budget is around $5k and we want this before September.',
    references: ['<pat-1@mail.example>'],
    inReplyTo: '<pat-1@mail.example>',
  })

  beforeAll(() => {
    scoredFor[danaReply.messageId] = {
      ...scoredFor[hotEmail.messageId]!,
      summary: 'Date agreed (the 22nd); Dana asked for a proposal for 40 seats.',
      recommendedNextStep: 'Send the proposal today.',
      urgencyScore: 9,
    }
    scoredFor[patSecond.messageId] = {
      ...scoredFor[hotEmail.messageId]!,
      name: 'Pat Ibarra',
      org: 'Harborlight',
      summary: '12-person AI enablement, ~$5k budget, wants delivery before September.',
      leadScore: 7,
      dealValueLow: 4000,
      dealValueHigh: 6000,
    }
  })

  it('a reply merges into the existing lead and re-scores with conversation context', async () => {
    const before = (await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })).json().total
    const scoreCalls: Array<{ messageId: string; context?: ConversationContext }> = []
    const result = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([danaReply], { scoreCalls }))
    expect(result.imported).toBe(0)
    expect(result.merged).toBe(1)

    // No new lead — the reply landed on the existing one.
    const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })
    expect(list.json().total).toBe(before)

    const hot = list.json().items.find((l: { externalId: string }) => l.externalId === hotEmail.messageId)
    const detail = (await api(app, owner, { method: 'GET', url: `/api/v1/leads/${hot.id}` })).json()
    expect(detail.threads).toHaveLength(2)
    // AI fields updated from the full conversation; human edits untouched.
    expect(detail.summary).toContain('proposal')
    expect(detail.stage).toBe('Contacted')
    expect(detail.notes).toBe('called them')
    expect(new Date(detail.receivedAt).toISOString()).toBe(hotEmail.date.toISOString())
    // lastTouchedAt reflects the most recent activity (a human PATCH bumped it
    // past the reply's date in an earlier test — merge never rolls it back).
    expect(new Date(detail.lastTouchedAt).getTime()).toBeGreaterThanOrEqual(danaReply.date.getTime())
    expect(detail.timeline.some((e: { type: string }) => e.type === 'email_received')).toBe(true)

    // The scorer saw the earlier exchange, not just the reply.
    expect(scoreCalls).toHaveLength(1)
    expect(scoreCalls[0]!.messageId).toBe(danaReply.messageId)
    expect(scoreCalls[0]!.context?.previousSummary).toContain('40-seat')
    expect(scoreCalls[0]!.context?.exchange.length).toBeGreaterThan(0)
  })

  it('several same-thread emails in one scan become one lead and one AI call', async () => {
    const scoreCalls: Array<{ messageId: string; context?: ConversationContext }> = []
    const result = await runScan(
      app.prisma,
      testConfig(),
      owner.workspace.id,
      fakeDeps([patFirst, patSecond], { scoreCalls }),
    )
    expect(result.imported).toBe(1)

    expect(scoreCalls).toHaveLength(1)
    expect(scoreCalls[0]!.messageId).toBe(patSecond.messageId)
    expect(scoreCalls[0]!.context?.exchange).toHaveLength(1)

    const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })
    const pat = list.json().items.find((l: { externalId: string }) => l.externalId === patFirst.messageId)
    const detail = (await api(app, owner, { method: 'GET', url: `/api/v1/leads/${pat.id}` })).json()
    expect(detail.threads).toHaveLength(2)
    expect(detail.summary).toContain('$5k')
  })

  it('a "Re:" without References still finds its conversation by sender + subject', async () => {
    const bareReply = email({
      messageId: '<hot-3@mail.example>',
      from: { name: 'Dana Okafor', address: 'dana@northwind.example' },
      subject: 'RE: AI training for our ops team',
      date: new Date('2026-07-16T15:00:00Z'),
      text: 'One more thing — can we add an exec briefing?',
    })
    scoredFor[bareReply.messageId] = scoredFor[danaReply.messageId]!
    const result = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([bareReply]))
    expect(result.merged).toBe(1)
    expect(result.imported).toBe(0)

    const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })
    const hot = list.json().items.find((l: { externalId: string }) => l.externalId === hotEmail.messageId)
    const detail = (await api(app, owner, { method: 'GET', url: `/api/v1/leads/${hot.id}` })).json()
    expect(detail.threads).toHaveLength(3)
  })

  it('a fresh subject from a known sender starts a new lead, not a merge', async () => {
    const fresh = email({
      messageId: '<dana-new-1@mail.example>',
      from: { name: 'Dana Okafor', address: 'dana@northwind.example' },
      subject: 'Different question about coaching',
      date: new Date('2026-07-16T16:00:00Z'),
      text: 'Separately — do you do 1:1 exec coaching?',
    })
    scoredFor[fresh.messageId] = { ...scoredFor[hotEmail.messageId]!, summary: 'Asks about 1:1 exec coaching.' }
    const result = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([fresh]))
    expect(result.imported).toBe(1)
    expect(result.merged).toBe(0)
  })

  it('sent mail attaches as an outbound reply: replySent, timeline, and stage advance', async () => {
    const ourReply = email({
      messageId: '<out-1@mail.example>',
      from: { name: 'Fieldstone', address: MAILBOX_ADDRESS },
      to: ['pat@harborlight.example'],
      subject: 'Re: Team enablement help',
      date: new Date('2026-07-16T17:00:00Z'),
      text: 'Happy to help — how about a call Thursday?',
      references: ['<pat-1@mail.example>'],
      inReplyTo: '<pat-2@mail.example>',
    })
    const result = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([], { sent: [ourReply] }))
    expect(result.replies).toBe(1)

    const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })
    const pat = list.json().items.find((l: { externalId: string }) => l.externalId === patFirst.messageId)
    const detail = (await api(app, owner, { method: 'GET', url: `/api/v1/leads/${pat.id}` })).json()
    expect(detail.replySent).toBe(true)
    expect(detail.stage).toBe('Contacted') // auto-advanced from New
    expect(detail.threads).toHaveLength(3)
    expect(detail.threads.some((t: { direction: string }) => t.direction === 'out')).toBe(true)
    expect(detail.timeline.some((e: { type: string; actor: string }) => e.type === 'reply_sent' && e.actor === 'system')).toBe(true)

    // Re-running the same sent mail is a no-op.
    const again = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([], { sent: [ourReply] }))
    expect(again.replies).toBe(0)
    const after = (await api(app, owner, { method: 'GET', url: `/api/v1/leads/${pat.id}` })).json()
    expect(after.threads).toHaveLength(3)
  })

  it('does not auto-advance a stage a human already moved', async () => {
    const ourReply = email({
      messageId: '<out-2@mail.example>',
      from: { name: 'Fieldstone', address: MAILBOX_ADDRESS },
      to: ['dana@northwind.example'],
      subject: 'Re: AI training for our ops team',
      date: new Date('2026-07-16T18:00:00Z'),
      text: 'Proposal attached.',
      references: ['<hot-1@mail.example>'],
    })
    const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads?pageSize=50' })
    const hot = list.json().items.find((l: { externalId: string }) => l.externalId === hotEmail.messageId)
    await api(app, owner, { method: 'PATCH', url: `/api/v1/leads/${hot.id}`, payload: { stage: 'Qualified' } })

    const result = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([], { sent: [ourReply] }))
    expect(result.replies).toBe(1)
    const detail = (await api(app, owner, { method: 'GET', url: `/api/v1/leads/${hot.id}` })).json()
    expect(detail.stage).toBe('Qualified') // human-owned; only New leads auto-advance
    expect(detail.replySent).toBe(true)
  })
})

describe('relevance gate + scan-window reliability', () => {
  it('a confident-irrelevant gate verdict skips full scoring entirely', async () => {
    const junk = email({
      messageId: '<gate-junk-1@mail.example>',
      from: { name: 'Deals Bot', address: 'promo@dealsbot.example' },
      subject: '50% OFF EVERYTHING',
      text: 'Unsubscribe here.',
    })
    const scoreCalls: Array<{ messageId: string }> = []
    const gateCalls: string[] = []
    const result = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([junk], {
      scoreCalls,
      gateCalls,
      gate: { [junk.messageId]: { decision: 'irrelevant', confidence: 0.95, reason: 'promotional blast' } },
    }))
    expect(result.ignored).toBe(1)
    expect(gateCalls).toEqual([junk.messageId])
    expect(scoreCalls).toHaveLength(0) // the expensive model never ran
    const audit = await app.prisma.scannedMessage.findUnique({
      where: { workspaceId_messageId: { workspaceId: owner.workspace.id, messageId: junk.messageId } },
    })
    expect(audit).toMatchObject({ status: 'skipped_irrelevant', decision: 'irrelevant', reason: 'promotional blast' })
  })

  it('a low-confidence irrelevant verdict escalates to the full scorer', async () => {
    const maybe = email({
      messageId: '<gate-maybe-1@mail.example>',
      from: { name: 'Quinn Ro', address: 'quinn@maybe.example' },
      subject: 'quick question',
      text: 'Do you folks do trainings?',
    })
    scoredFor[maybe.messageId] = { ...scoredFor[hotEmail.messageId]!, summary: 'Asks about trainings.' }
    const scoreCalls: Array<{ messageId: string }> = []
    const result = await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([maybe], {
      scoreCalls,
      gate: { [maybe.messageId]: { decision: 'irrelevant', confidence: 0.4, reason: 'not sure' } },
    }))
    expect(scoreCalls).toHaveLength(1) // uncertainty is escalated, never discarded
    expect(result.imported).toBe(1)
    const audit = await app.prisma.scannedMessage.findUnique({
      where: { workspaceId_messageId: { workspaceId: owner.workspace.id, messageId: maybe.messageId } },
    })
    expect(audit?.status).toBe('processed_lead')
  })

  it('a capped (partial) window advances the cursor only to the newest processed email', async () => {
    const older = email({
      messageId: '<window-1@mail.example>',
      from: { name: 'Ada Voss', address: 'ada@window.example' },
      subject: 'Workshop question',
      date: new Date('2026-07-14T08:00:00Z'),
      text: 'Interested in a workshop.',
    })
    scoredFor[older.messageId] = { ...scoredFor[hotEmail.messageId]!, summary: 'Workshop question.' }
    // Pin the cursor before the email so the window math is deterministic.
    const cred0 = await app.prisma.credential.findUniqueOrThrow({
      where: { workspaceId_kind: { workspaceId: owner.workspace.id, kind: 'GMAIL_IMAP' } },
    })
    await app.prisma.credential.update({
      where: { id: cred0.id },
      data: { meta: { ...(cred0.meta as object), lastScanAt: '2026-07-14T00:00:00.000Z' } },
    })
    // Fetch returns exactly emailCap emails → the window was not fully read.
    await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([older]), { emailCap: 1 })
    const cred = await app.prisma.credential.findUniqueOrThrow({
      where: { workspaceId_kind: { workspaceId: owner.workspace.id, kind: 'GMAIL_IMAP' } },
    })
    const cursor = new Date((cred.meta as { lastScanAt: string }).lastScanAt)
    expect(cursor.toISOString()).toBe(older.date.toISOString()) // NOT "now" — the rest of the window survives

    // An uncapped scan covers the whole window and advances to scan time.
    const before = Date.now()
    await runScan(app.prisma, testConfig(), owner.workspace.id, fakeDeps([]))
    const cred2 = await app.prisma.credential.findUniqueOrThrow({
      where: { workspaceId_kind: { workspaceId: owner.workspace.id, kind: 'GMAIL_IMAP' } },
    })
    expect(new Date((cred2.meta as { lastScanAt: string }).lastScanAt).getTime()).toBeGreaterThanOrEqual(before - 1000)
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
