import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { api, makeApp, resetDb, signup, type Session } from './helpers.js'

let app: FastifyInstance
let owner: Session
let apiKey: string
let apiKeyId: string

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalId: 'thread_abc123',
    receivedAt: '2026-07-06T14:12:00Z',
    name: 'Dana Okafor',
    email: 'dana.okafor@northwind-logistics.example',
    org: 'Northwind Logistics',
    source: 'Email',
    inquiryType: 'New project / hot lead',
    summary: '40-seat AI training request with executive briefing',
    fitScore: 9,
    urgencyScore: 8,
    leadScore: 9,
    dealValueLow: 6000,
    dealValueHigh: 12000,
    estPayoutRaw: '$6,000–12,000 — 40-seat + exec, clear budget',
    estWork: '~20–30 hrs delivery',
    recommendedNextStep: 'Offer a 20-min scoping call this week.',
    draftReply: 'Hi Dana, thanks for reaching out…',
    fitReasons: ['Decision-maker (VP)', 'Budget allocated'],
    riskFlags: ['Exact dates unconfirmed'],
    inferredFields: ['dealValueLow', 'dealValueHigh'],
    threads: [
      {
        subject: 'AI training for our team',
        url: 'https://mail.google.com/mail/u/0/#all/abc123',
        direction: 'in',
        date: '2026-07-06T14:12:00Z',
        snippet: 'We are looking for a hands-on AI training…',
      },
    ],
    ...overrides,
  }
}

function ingest(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/ingest/leads',
    headers: { 'x-api-key': apiKey, ...headers },
    payload,
  })
}

beforeAll(async () => {
  app = await makeApp()
  await resetDb(app)
  owner = await signup(app, { email: 'owner@ingest.test', workspaceName: 'Ingest Co' })
  const keyRes = await api(app, owner, {
    method: 'POST',
    url: '/api/v1/workspace/api-keys',
    payload: { name: 'n8n production' },
  })
  expect(keyRes.statusCode).toBe(201)
  apiKey = keyRes.json().key
  apiKeyId = keyRes.json().id
  expect(apiKey.startsWith('llk_')).toBe(true)
})

afterAll(async () => {
  await app.close()
})

describe('API key management', () => {
  it('returns the full key exactly once; lists expose only the prefix', async () => {
    const list = await api(app, owner, { method: 'GET', url: '/api/v1/workspace/api-keys' })
    const listed = list.json().apiKeys.find((key: { id: string }) => key.id === apiKeyId)
    expect(listed.prefix).toBe(apiKey.slice(0, 8))
    expect(JSON.stringify(list.json())).not.toContain(apiKey)
  })
})

describe('ingest auth', () => {
  it('rejects a missing or invalid key', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/v1/ingest/leads', payload: basePayload() })
    expect(missing.statusCode).toBe(401)
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/leads',
      headers: { 'x-api-key': 'llk_definitely-not-a-key' },
      payload: basePayload(),
    })
    expect(wrong.statusCode).toBe(401)
  })
})

describe('idempotent upsert by externalId', () => {
  it('creates on first POST with computed fields, a system timeline event and threads', async () => {
    const res = await ingest(basePayload())
    expect(res.statusCode).toBe(201)
    expect(res.json().created).toBe(true)

    const detail = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${res.json().id}` })
    const lead = detail.json()
    expect(lead.externalId).toBe('thread_abc123')
    expect(lead.stage).toBe('New')
    expect(lead.tier).toBe('hot')
    expect(lead.winProbability).toBe(0.55)
    expect(lead.expectedValue).toBe(4950)
    expect(lead.threads).toHaveLength(1)
    expect(lead.timeline[0].type).toBe('created')
    expect(lead.timeline[0].actor).toBe('system')
  })

  it('re-POSTing the same externalId updates instead of duplicating', async () => {
    const first = await ingest(basePayload())
    expect(first.statusCode).toBe(200)
    expect(first.json().created).toBe(false)

    const updated = await ingest(
      basePayload({
        summary: 'UPDATED summary after n8n re-run',
        leadScore: 4,
        dealValueLow: 1000,
        dealValueHigh: 2000,
        threads: [
          {
            subject: 'AI training for our team',
            url: 'https://mail.google.com/mail/u/0/#all/abc123',
            direction: 'in',
            date: '2026-07-06T14:12:00Z',
            snippet: 'original…',
          },
          {
            subject: 'Re: AI training for our team',
            url: 'https://mail.google.com/mail/u/0/#all/abc124',
            direction: 'out',
            date: '2026-07-06T16:00:00Z',
            snippet: 'our reply…',
          },
        ],
      }),
    )
    expect(updated.statusCode).toBe(200)
    expect(updated.json().created).toBe(false)

    const list = await api(app, owner, { method: 'GET', url: '/api/v1/leads' })
    expect(list.json().total).toBe(1) // still exactly one row

    const detail = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${updated.json().id}` })
    const lead = detail.json()
    expect(lead.summary).toBe('UPDATED summary after n8n re-run')
    expect(lead.leadScore).toBe(4)
    expect(lead.tier).toBe('cold') // recomputed
    expect(lead.winProbability).toBe(0.07)
    expect(lead.threads).toHaveLength(2) // replaced, not appended
    expect(lead.timeline.filter((event: { type: string }) => event.type === 'created')).toHaveLength(1)
  })

  it('human-owned fields survive re-ingestion', async () => {
    const leadId = (await ingest(basePayload())).json().id

    await api(app, owner, {
      method: 'PATCH',
      url: `/api/v1/leads/${leadId}`,
      payload: { stage: 'Contacted', notes: 'Spoke on the phone, promising', winProbability: 0.9 },
    })

    const reingest = await ingest(basePayload({ dealValueLow: 2000, dealValueHigh: 4000, leadScore: 8 }))
    expect(reingest.statusCode).toBe(200)

    const detail = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${leadId}` })
    const lead = detail.json()
    expect(lead.stage).toBe('Contacted') // kept
    expect(lead.notes).toBe('Spoke on the phone, promising') // kept
    expect(lead.winProbability).toBe(0.9) // manual override kept
    expect(lead.expectedValue).toBe(2700) // ((2000+4000)/2) * 0.9 — new values, kept probability
    expect(lead.leadScore).toBe(8) // AI field updated
  })

  it('validates the payload', async () => {
    expect((await ingest(basePayload({ externalId: undefined }))).statusCode).toBe(400)
    expect((await ingest(basePayload({ email: 'not-an-email' }))).statusCode).toBe(400)
    expect((await ingest(basePayload({ leadScore: 11 }))).statusCode).toBe(400)
    expect((await ingest(basePayload({ receivedAt: 'yesterdayish' }))).statusCode).toBe(400)
  })

  it('GET /leads?include=threads,timeline embeds relations in list items', async () => {
    const plain = await api(app, owner, { method: 'GET', url: '/api/v1/leads' })
    expect(plain.json().items[0].threads).toBeUndefined()
    expect(plain.json().items[0].timeline).toBeUndefined()

    const res = await api(app, owner, { method: 'GET', url: '/api/v1/leads?include=threads,timeline' })
    expect(res.statusCode).toBe(200)
    const item = res.json().items.find((l: { externalId: string }) => l.externalId === 'thread_abc123')
    expect(Array.isArray(item.threads)).toBe(true)
    expect(item.threads.length).toBeGreaterThan(0)
    expect(item.timeline.some((e: { type: string }) => e.type === 'created')).toBe(true)
  })

  it('tracks lastUsedAt on the key', async () => {
    const list = await api(app, owner, { method: 'GET', url: '/api/v1/workspace/api-keys' })
    const key = list.json().apiKeys.find((row: { id: string }) => row.id === apiKeyId)
    expect(key.lastUsedAt).not.toBeNull()
  })

  it('a revoked key stops working', async () => {
    const revoke = await api(app, owner, { method: 'DELETE', url: `/api/v1/workspace/api-keys/${apiKeyId}` })
    expect(revoke.statusCode).toBe(200)
    const res = await ingest(basePayload())
    expect(res.statusCode).toBe(401)

    // Re-arm for the HMAC suite below.
    const keyRes = await api(app, owner, {
      method: 'POST',
      url: '/api/v1/workspace/api-keys',
      payload: { name: 'n8n second' },
    })
    apiKey = keyRes.json().key
    apiKeyId = keyRes.json().id
  })
})

describe('HMAC signature (INGEST_HMAC_ENABLED)', () => {
  let hmacApp: FastifyInstance
  const secret = 'whsec_test_secret_0042'

  function signedIngest(bodyObj: Record<string, unknown>, signature?: string) {
    const body = JSON.stringify(bodyObj)
    return hmacApp.inject({
      method: 'POST',
      url: '/api/v1/ingest/leads',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        ...(signature !== undefined ? { 'x-signature': signature } : {}),
      },
      payload: body,
    })
  }

  beforeAll(async () => {
    hmacApp = await makeApp({ INGEST_HMAC_ENABLED: 'true' })
  })

  afterAll(async () => {
    await hmacApp.close()
  })

  it('passes without a signature while no N8N_WEBHOOK secret is stored', async () => {
    const res = await signedIngest(basePayload({ externalId: 'hmac-pre' }))
    expect([200, 201]).toContain(res.statusCode)
  })

  it('enforces the signature once the workspace stores an N8N_WEBHOOK secret', async () => {
    const put = await api(app, owner, {
      method: 'PUT',
      url: '/api/v1/workspace/credentials/N8N_WEBHOOK',
      payload: { value: secret },
    })
    expect(put.statusCode).toBe(200)

    const payload = basePayload({ externalId: 'hmac-1' })

    const unsigned = await signedIngest(payload)
    expect(unsigned.statusCode).toBe(401)

    const badlySigned = await signedIngest(payload, 'deadbeef')
    expect(badlySigned.statusCode).toBe(401)

    const goodSig = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')
    const signed = await signedIngest(payload, goodSig)
    expect(signed.statusCode).toBe(201)
    expect(signed.json().created).toBe(true)
  })
})
