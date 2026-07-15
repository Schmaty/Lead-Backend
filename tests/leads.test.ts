import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { addMember, api, createLead, daysFromNow, makeApp, resetDb, signup, type Session } from './helpers.js'

let app: FastifyInstance
let owner: Session
let member: Session

beforeAll(async () => {
  app = await makeApp()
  await resetDb(app)
  owner = await signup(app, { email: 'owner@leads.test', workspaceName: 'Leads Co' })
  member = await addMember(app, owner, 'member@leads.test')
})

afterAll(async () => {
  await app.close()
})

describe('create + computed fields', () => {
  it('fills defaults and computes tier/winProbability/expectedValue', async () => {
    const lead = await createLead(app, owner, { name: 'Default Dana', email: 'dana@d.test' })
    expect(lead.stage).toBe('New')
    expect(lead.leadScore).toBe(5)
    expect(lead.tier).toBe('warm') // 5 is within warm 5–7
    expect(lead.winProbability).toBe(0.18)
    expect(lead.expectedValue).toBe(0)
    expect(lead.ownerId).toBeNull()
    expect(lead.replySent).toBe(false)
  })

  it('computes hot tier and expected value from the deal range', async () => {
    const lead = await createLead(app, owner, {
      name: 'Hot Harriet',
      email: 'h@h.test',
      leadScore: 9,
      fitScore: 9,
      urgencyScore: 8,
      dealValueLow: 6000,
      dealValueHigh: 12000,
    })
    expect(lead.tier).toBe('hot')
    expect(lead.winProbability).toBe(0.55)
    expect(lead.expectedValue).toBe(4950) // ((6000+12000)/2) * 0.55
  })

  it('writes a created timeline event', async () => {
    const lead = await createLead(app, owner, { name: 'Timeline Tom', email: 't@t.test' })
    const detail = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${lead.id}` })
    expect(detail.statusCode).toBe(200)
    const body = detail.json()
    expect(body.timeline).toHaveLength(1)
    expect(body.timeline[0].type).toBe('created')
    expect(body.threads).toEqual([])
    expect(typeof body.timeInStageHours).toBe('number')
  })

  it('rejects unknown stages, foreign owners and unknown fields', async () => {
    const badStage = await api(app, owner, {
      method: 'POST',
      url: '/api/v1/leads',
      payload: { name: 'X', email: 'x@x.test', stage: 'Warp drive' },
    })
    expect(badStage.statusCode).toBe(400)

    const badOwner = await api(app, owner, {
      method: 'POST',
      url: '/api/v1/leads',
      payload: { name: 'X', email: 'x@x.test', ownerId: 'not-a-user' },
    })
    expect(badOwner.statusCode).toBe(400)

    const unknownField = await api(app, owner, {
      method: 'POST',
      url: '/api/v1/leads',
      payload: { name: 'X', email: 'x@x.test', tier: 'hot' },
    })
    expect(unknownField.statusCode).toBe(400)
  })
})

describe('PATCH safe fields', () => {
  it('rejects AI/computed fields and lists the offenders', async () => {
    const lead = await createLead(app, owner, { name: 'Patch Pam', email: 'p@p.test' })
    const res = await api(app, owner, {
      method: 'PATCH',
      url: `/api/v1/leads/${lead.id}`,
      payload: { fitScore: 10, leadScore: 10, stage: 'Contacted' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().details.rejectedFields).toEqual(['fitScore', 'leadScore'])

    // Nothing was applied.
    const detail = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${lead.id}` })
    expect(detail.json().stage).toBe('New')
    expect(detail.json().fitScore).toBe(5)
  })

  it('updates stage with a timeline event and bumps lastTouchedAt', async () => {
    const lead = await createLead(app, owner, { name: 'Stage Steve', email: 's@s.test' })
    const before = lead.lastTouchedAt
    await new Promise((resolve) => setTimeout(resolve, 5))
    const res = await api(app, owner, {
      method: 'PATCH',
      url: `/api/v1/leads/${lead.id}`,
      payload: { stage: 'Contacted' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().stage).toBe('Contacted')
    expect(new Date(res.json().lastTouchedAt).getTime()).toBeGreaterThan(new Date(before).getTime())

    const detail = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${lead.id}` })
    const events = detail.json().timeline
    expect(events.at(-1).type).toBe('stage_change')
    expect(events.at(-1).detail).toBe('New → Contacted')
    expect(events.at(-1).actor).toBe(owner.user.name)
  })

  it('rejects an unknown stage value', async () => {
    const lead = await createLead(app, owner, { name: 'Bad Stage', email: 'bs@s.test' })
    const res = await api(app, owner, {
      method: 'PATCH',
      url: `/api/v1/leads/${lead.id}`,
      payload: { stage: 'Nonsense' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('assigns and unassigns owners with owner_change events', async () => {
    const lead = await createLead(app, owner, { name: 'Owner Olive', email: 'o@o.test' })
    const assign = await api(app, owner, {
      method: 'PATCH',
      url: `/api/v1/leads/${lead.id}`,
      payload: { ownerId: member.user.id },
    })
    expect(assign.statusCode).toBe(200)
    expect(assign.json().ownerId).toBe(member.user.id)
    expect(assign.json().owner.name).toBe(member.user.name)

    const unassign = await api(app, owner, {
      method: 'PATCH',
      url: `/api/v1/leads/${lead.id}`,
      payload: { ownerId: 'unassigned' },
    })
    expect(unassign.json().ownerId).toBeNull()

    const foreign = await api(app, owner, {
      method: 'PATCH',
      url: `/api/v1/leads/${lead.id}`,
      payload: { ownerId: 'someone-else' },
    })
    expect(foreign.statusCode).toBe(400)

    const detail = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${lead.id}` })
    const ownerEvents = detail.json().timeline.filter((e: { type: string }) => e.type === 'owner_change')
    expect(ownerEvents).toHaveLength(2)
  })

  it('sets follow-up, notes and replySent with events', async () => {
    const lead = await createLead(app, owner, { name: 'Follow Fred', email: 'f@f.test' })
    const followUp = daysFromNow(3)
    const res = await api(app, owner, {
      method: 'PATCH',
      url: `/api/v1/leads/${lead.id}`,
      payload: { followUpDate: followUp, notes: 'Call after lunch', replySent: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().replySent).toBe(true)
    expect(res.json().notes).toBe('Call after lunch')
    expect(new Date(res.json().followUpDate).toISOString()).toBe(new Date(followUp).toISOString())

    const detail = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${lead.id}` })
    const types = detail.json().timeline.map((e: { type: string }) => e.type)
    expect(types).toContain('follow_up_set')
    expect(types).toContain('note_added')
    expect(types).toContain('reply_sent')
  })

  it('winProbability is human-overridable and recomputes expectedValue', async () => {
    const lead = await createLead(app, owner, {
      name: 'Override Oscar',
      email: 'ov@o.test',
      leadScore: 9,
      dealValueLow: 1000,
      dealValueHigh: 3000,
    })
    expect(lead.winProbability).toBe(0.55)
    const res = await api(app, owner, {
      method: 'PATCH',
      url: `/api/v1/leads/${lead.id}`,
      payload: { winProbability: 0.8 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().winProbability).toBe(0.8)
    expect(res.json().winProbabilityOverridden).toBe(true)
    expect(res.json().expectedValue).toBe(1600) // 2000 * 0.8

    const outOfRange = await api(app, owner, {
      method: 'PATCH',
      url: `/api/v1/leads/${lead.id}`,
      payload: { winProbability: 1.5 },
    })
    expect(outOfRange.statusCode).toBe(400)
  })

  it('404s for unknown lead ids', async () => {
    const res = await api(app, owner, {
      method: 'PATCH',
      url: '/api/v1/leads/does-not-exist',
      payload: { stage: 'Contacted' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('delete', () => {
  it('MEMBER cannot delete; ADMIN/OWNER soft-deletes', async () => {
    const lead = await createLead(app, owner, { name: 'Delete Dave', email: 'dd@d.test' })

    const asMember = await api(app, member, { method: 'DELETE', url: `/api/v1/leads/${lead.id}` })
    expect(asMember.statusCode).toBe(403)

    const asOwner = await api(app, owner, { method: 'DELETE', url: `/api/v1/leads/${lead.id}` })
    expect(asOwner.statusCode).toBe(200)

    const detail = await api(app, owner, { method: 'GET', url: `/api/v1/leads/${lead.id}` })
    expect(detail.statusCode).toBe(404)

    // Soft delete: the row still exists, flagged.
    const row = await app.prisma.lead.findUnique({ where: { id: lead.id } })
    expect(row?.deletedAt).not.toBeNull()

    // Delete is audited.
    const auditRow = await app.prisma.auditLog.findFirst({
      where: { workspaceId: owner.workspace.id, action: 'lead.deleted' },
    })
    expect(auditRow).not.toBeNull()
  })
})

describe('workspace settings recompute leads', () => {
  it('changing thresholds and the probability map recomputes derived fields', async () => {
    const fresh = await signup(app, { email: 'owner@recompute.test', workspaceName: 'Recompute Co' })
    const lead = await createLead(app, fresh, {
      name: 'Boundary Bella',
      email: 'b@b.test',
      leadScore: 7,
      dealValueLow: 1000,
      dealValueHigh: 1000,
    })
    expect(lead.tier).toBe('warm')
    expect(lead.winProbability).toBe(0.35)

    const overridden = await createLead(app, fresh, {
      name: 'Sticky Sam',
      email: 'ss@b.test',
      leadScore: 7,
      dealValueLow: 1000,
      dealValueHigh: 1000,
    })
    await api(app, fresh, {
      method: 'PATCH',
      url: `/api/v1/leads/${overridden.id}`,
      payload: { winProbability: 0.9 },
    })

    const res = await api(app, fresh, {
      method: 'PATCH',
      url: '/api/v1/workspace/settings',
      payload: { tierThresholds: { hot: 6, warm: 3 }, winProbabilityMap: [{ min: 0, p: 0.5 }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().recomputedLeads).toBeGreaterThanOrEqual(1)

    const after = await api(app, fresh, { method: 'GET', url: `/api/v1/leads/${lead.id}` })
    expect(after.json().tier).toBe('hot') // 7 >= new hot threshold 6
    expect(after.json().winProbability).toBe(0.5)
    expect(after.json().expectedValue).toBe(500)

    // The manual override survives recomputation.
    const sticky = await api(app, fresh, { method: 'GET', url: `/api/v1/leads/${overridden.id}` })
    expect(sticky.json().winProbability).toBe(0.9)
  })

  it('rejects settings where wonStage is not one of stages', async () => {
    const res = await api(app, owner, {
      method: 'PATCH',
      url: '/api/v1/workspace/settings',
      payload: { stages: ['New', 'Done'] },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('credentials are encrypted and masked', () => {
  it('stores encrypted, returns masked, never returns the raw value', async () => {
    const secret = 'sk-ant-api-key-super-secret-0042'
    const put = await api(app, owner, {
      method: 'PUT',
      url: '/api/v1/workspace/credentials/ANTHROPIC_API_KEY',
      payload: { value: secret },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().maskedValue).toBe('sk-…0042')
    expect(JSON.stringify(put.json())).not.toContain(secret)

    const list = await api(app, owner, { method: 'GET', url: '/api/v1/workspace/credentials' })
    expect(list.json().credentials[0].maskedValue).toBe('sk-…0042')
    expect(JSON.stringify(list.json())).not.toContain(secret)

    // At rest: ciphertext, not plaintext.
    const row = await app.prisma.credential.findFirstOrThrow({
      where: { workspaceId: owner.workspace.id, kind: 'ANTHROPIC_API_KEY' },
    })
    expect(row.encryptedValue).not.toContain(secret)
    expect(row.encryptedValue.split(':')).toHaveLength(3)

    const del = await api(app, owner, {
      method: 'DELETE',
      url: '/api/v1/workspace/credentials/ANTHROPIC_API_KEY',
    })
    expect(del.statusCode).toBe(200)
    expect(
      (await api(app, owner, { method: 'DELETE', url: '/api/v1/workspace/credentials/ANTHROPIC_API_KEY' }))
        .statusCode,
    ).toBe(404)
  })
})
