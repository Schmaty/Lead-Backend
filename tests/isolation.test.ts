import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { api, createLead, makeApp, resetDb, signup, type Session } from './helpers.js'

let app: FastifyInstance
let alice: Session
let bob: Session
let aliceLeadId: string

beforeAll(async () => {
  // bob doubles as the platform developer so he can mint an ingest API key.
  app = await makeApp({ DEVELOPER_EMAILS: 'bob@iso.test' })
  await resetDb(app)
  alice = await signup(app, { email: 'alice@iso.test', workspaceName: 'Alice Co' })
  bob = await signup(app, { email: 'bob@iso.test', workspaceName: 'Bob Co' })
  const lead = await createLead(app, alice, { name: 'Alice Lead', email: 'lead@alice.test' })
  aliceLeadId = lead.id
})

afterAll(async () => {
  await app.close()
})

describe('workspace isolation', () => {
  it('a user never sees another workspace’s leads in lists', async () => {
    const res = await api(app, bob, { method: 'GET', url: '/api/v1/leads' })
    expect(res.statusCode).toBe(200)
    expect(res.json().total).toBe(0)
    expect(res.json().items).toEqual([])

    const aliceList = await api(app, alice, { method: 'GET', url: '/api/v1/leads' })
    expect(aliceList.json().total).toBe(1)
  })

  it('cross-workspace reads, patches and deletes 404 (even for an OWNER)', async () => {
    const read = await api(app, bob, { method: 'GET', url: `/api/v1/leads/${aliceLeadId}` })
    expect(read.statusCode).toBe(404)

    const patch = await api(app, bob, {
      method: 'PATCH',
      url: `/api/v1/leads/${aliceLeadId}`,
      payload: { stage: 'Contacted' },
    })
    expect(patch.statusCode).toBe(404)

    const del = await api(app, bob, { method: 'DELETE', url: `/api/v1/leads/${aliceLeadId}` })
    expect(del.statusCode).toBe(404)

    // Nothing changed for Alice.
    const still = await api(app, alice, { method: 'GET', url: `/api/v1/leads/${aliceLeadId}` })
    expect(still.statusCode).toBe(200)
    expect(still.json().stage).toBe('New')
  })

  it('workspace endpoints only expose the caller’s workspace', async () => {
    const ws = await api(app, bob, { method: 'GET', url: '/api/v1/workspace' })
    expect(ws.json().id).toBe(bob.workspace.id)
    expect(ws.json().users.map((u: { email: string }) => u.email)).toEqual(['bob@iso.test'])
  })

  it('an ingest key writes only into its own workspace', async () => {
    const keyRes = await api(app, bob, {
      method: 'POST',
      url: '/api/v1/workspace/api-keys',
      payload: { name: 'bob-n8n' },
    })
    const { key } = keyRes.json()
    const ingest = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/leads',
      headers: { 'x-api-key': key },
      payload: {
        externalId: 'iso-1',
        receivedAt: new Date().toISOString(),
        name: 'Ingested For Bob',
        email: 'ing@bob.test',
        source: 'Email',
        inquiryType: 'Other',
        fitScore: 5,
        urgencyScore: 5,
        leadScore: 5,
      },
    })
    expect(ingest.statusCode).toBe(201)

    const bobList = await api(app, bob, { method: 'GET', url: '/api/v1/leads' })
    expect(bobList.json().total).toBe(1)
    const aliceList = await api(app, alice, { method: 'GET', url: '/api/v1/leads' })
    expect(aliceList.json().total).toBe(1)
    expect(aliceList.json().items[0].name).toBe('Alice Lead')
  })
})
