import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { signResetToken } from '../src/auth/tokens.js'
import { addMember, api, extractRefreshCookie, makeApp, resetDb, signup, testConfig } from './helpers.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await makeApp()
  await resetDb(app)
})

afterAll(async () => {
  await app.close()
})

describe('signup', () => {
  it('creates a workspace with default settings and an OWNER user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        workspaceName: 'Acme Training',
        name: 'Ada Owner',
        email: 'ada@acme.test',
        password: 'a-long-and-decent-password',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.user.role).toBe('OWNER')
    expect(body.workspace.slug).toBe('acme-training')
    expect(body.workspace.settings.tierThresholds).toEqual({ hot: 8, warm: 5 })
    expect(body.accessToken).toBeTruthy()
    expect(extractRefreshCookie(res)).toContain('leadline_refresh=')
    expect(extractRefreshCookie(res)).not.toContain('leadline_refresh=;')

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().user.email).toBe('ada@acme.test')
    expect(me.json().workspace.id).toBe(body.workspace.id)
  })

  it('rejects a duplicate email with 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        workspaceName: 'Other Co',
        name: 'Ada Again',
        email: 'ada@acme.test',
        password: 'another-long-password-1',
      },
    })
    expect(res.statusCode).toBe(409)
  })

  it('enforces the password policy (length and common passwords)', async () => {
    const short = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { workspaceName: 'X', name: 'X', email: 'short@x.test', password: 'tooshort' },
    })
    expect(short.statusCode).toBe(400)
    expect(short.json().error).toMatch(/12 characters/)

    const common = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { workspaceName: 'X', name: 'X', email: 'common@x.test', password: 'password12345' },
    })
    expect(common.statusCode).toBe(400)
    expect(common.json().error).toMatch(/too common/)
  })
})

describe('login / refresh / logout', () => {
  const email = 'login@acme.test'
  const password = 'super-secret-sign-in-pass-1'

  beforeAll(async () => {
    await signup(app, { email, password, workspaceName: 'Login Co' })
  })

  it('logs in with correct credentials and rejects bad ones', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().accessToken).toBeTruthy()

    const badPass = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'wrong-password-entirely' },
    })
    expect(badPass.statusCode).toBe(401)

    const badUser = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@acme.test', password },
    })
    expect(badUser.statusCode).toBe(401)
    // Same generic message for both failure modes (no user enumeration).
    expect(badUser.json().error).toBe(badPass.json().error)
  })

  it('rotates refresh tokens and revokes everything on reuse', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } })
    const cookie1 = extractRefreshCookie(login)

    const refresh1 = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: cookie1 } })
    expect(refresh1.statusCode).toBe(200)
    const cookie2 = extractRefreshCookie(refresh1)
    expect(cookie2).not.toBe(cookie1)

    // Reusing the rotated-out token is treated as theft…
    const reuse = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: cookie1 } })
    expect(reuse.statusCode).toBe(401)
    expect(reuse.json().error).toMatch(/reuse/i)

    // …and every other session (incl. the fresh cookie) is revoked.
    const afterReuse = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: cookie2 } })
    expect(afterReuse.statusCode).toBe(401)
  })

  it('reuse within the grace window is a benign race, not theft', async () => {
    // Separate app instance with the production-like 10s grace window.
    const graceApp = await makeApp({ REFRESH_REUSE_GRACE: '10s' })
    try {
      const login = await graceApp.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } })
      const cookie1 = extractRefreshCookie(login)
      const refresh1 = await graceApp.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: cookie1 } })
      expect(refresh1.statusCode).toBe(200)
      const cookie2 = extractRefreshCookie(refresh1)

      // A parallel tab replays cookie1 immediately: rejected but NOT nuclear —
      // and it must not clear the (shared) cookie jar's newer cookie.
      const raced = await graceApp.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: cookie1 } })
      expect(raced.statusCode).toBe(401)
      expect(raced.headers['set-cookie']).toBeUndefined()

      // The winning tab's cookie still works.
      const refresh2 = await graceApp.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: cookie2 } })
      expect(refresh2.statusCode).toBe(200)
    } finally {
      await graceApp.close()
    }
  })

  it('logout revokes the refresh token', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } })
    const cookie = extractRefreshCookie(login)
    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } })
    expect(logout.statusCode).toBe(200)
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie } })
    expect(refresh.statusCode).toBe(401)
  })

  it('rejects requests without or with a garbage access token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: 'Bearer nope' } }))
        .statusCode,
    ).toBe(401)
  })
})

describe('invites and roles', () => {
  it('OWNER invites a MEMBER who lands in the same workspace', async () => {
    const owner = await signup(app, { email: 'owner@invites.test', workspaceName: 'Invites Co' })
    const member = await addMember(app, owner, 'member@invites.test')
    expect(member.workspace.id).toBe(owner.workspace.id)
    expect(member.user.role).toBe('MEMBER')

    // Accepting the same invite again fails: the email now exists.
    const invite = await api(app, owner, {
      method: 'POST',
      url: '/api/v1/auth/invite',
      payload: { email: 'member@invites.test', role: 'MEMBER' },
    })
    expect(invite.statusCode).toBe(409)
  })

  it('MEMBER cannot invite or manage credentials/api keys', async () => {
    const owner = await signup(app, { email: 'owner2@invites.test', workspaceName: 'Invites Two' })
    const member = await addMember(app, owner, 'member2@invites.test')

    const invite = await api(app, member, {
      method: 'POST',
      url: '/api/v1/auth/invite',
      payload: { email: 'x@invites.test', role: 'MEMBER' },
    })
    expect(invite.statusCode).toBe(403)

    const keys = await api(app, member, { method: 'POST', url: '/api/v1/workspace/api-keys', payload: { name: 'k' } })
    expect(keys.statusCode).toBe(403)

    const creds = await api(app, member, { method: 'GET', url: '/api/v1/workspace/credentials' })
    expect(creds.statusCode).toBe(403)
  })

  it('ADMIN invitees can manage api keys', async () => {
    const owner = await signup(app, { email: 'owner3@invites.test', workspaceName: 'Invites Three' })
    const admin = await addMember(app, owner, 'admin3@invites.test', 'ADMIN')
    const keys = await api(app, admin, { method: 'POST', url: '/api/v1/workspace/api-keys', payload: { name: 'k' } })
    expect(keys.statusCode).toBe(201)
  })
})

describe('password change and reset', () => {
  it('change requires the current password and revokes old sessions', async () => {
    const email = 'change@pw.test'
    const owner = await signup(app, { email, password: 'original-password-abc-1', workspaceName: 'PW Co' })

    const wrong = await api(app, owner, {
      method: 'POST',
      url: '/api/v1/auth/password/change',
      payload: { currentPassword: 'not-the-password-at-all', newPassword: 'brand-new-password-xyz-2' },
    })
    expect(wrong.statusCode).toBe(401)

    const ok = await api(app, owner, {
      method: 'POST',
      url: '/api/v1/auth/password/change',
      payload: { currentPassword: 'original-password-abc-1', newPassword: 'brand-new-password-xyz-2' },
    })
    expect(ok.statusCode).toBe(200)

    // The pre-change refresh cookie is dead; the new password logs in.
    const oldRefresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: owner.refreshCookie },
    })
    expect(oldRefresh.statusCode).toBe(401)
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'brand-new-password-xyz-2' },
    })
    expect(login.statusCode).toBe(200)
  })

  it('reset-request always returns 200; a valid token resets exactly once', async () => {
    const email = 'reset@pw.test'
    await signup(app, { email, password: 'password-before-rotation-1', workspaceName: 'Reset Co' })

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset-request',
      payload: { email: 'ghost@pw.test' },
    })
    expect(unknown.statusCode).toBe(200)
    const known = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset-request',
      payload: { email },
    })
    expect(known.statusCode).toBe(200)
    expect(known.json()).toEqual(unknown.json())

    // Without SMTP the link only goes to server logs; mint the same token here.
    const user = await app.prisma.user.findUniqueOrThrow({ where: { email } })
    const token = signResetToken(user, testConfig())

    const weak = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { token, newPassword: 'short' },
    })
    expect(weak.statusCode).toBe(400)

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { token, newPassword: 'password-after-rotation-22' },
    })
    expect(reset.statusCode).toBe(200)

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'password-after-rotation-22' },
    })
    expect(login.statusCode).toBe(200)

    // The token embeds a fingerprint of the old hash → single-use.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { token, newPassword: 'yet-another-password-33' },
    })
    expect(replay.statusCode).toBe(400)
  })
})
