import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { signGmailConnectToken } from '../src/auth/tokens.js'
import { setGoogleOauthDepsForTesting } from '../src/modules/pipeline/googleOauth.js'
import type { InboundEmail, MailboxConfig } from '../src/modules/pipeline/mailbox.js'
import { runScan, setScanDepsForTesting } from '../src/modules/pipeline/scanner.js'
import type { ScoredLead } from '../src/modules/pipeline/scorer.js'
import { addMember, api, makeApp, resetDb, signup, testConfig, type Session } from './helpers.js'

const DEV_EMAIL = 'dev@platform.test'
const ENV = { DEVELOPER_EMAILS: DEV_EMAIL }

let app: FastifyInstance
let developer: Session
let client: Session // OWNER of a client workspace — NOT on the allowlist
let clientMember: Session

beforeAll(async () => {
  app = await makeApp(ENV)
  await resetDb(app)
  developer = await signup(app, { email: DEV_EMAIL, workspaceName: 'Platform HQ' })
  client = await signup(app, { email: 'owner@client.test', workspaceName: 'Client Co' })
  clientMember = await addMember(app, client, 'member@client.test')
})

afterAll(async () => {
  await app.close()
})

describe('developer allowlist', () => {
  it('flags the allowlisted account as developer everywhere users are listed', async () => {
    const me = await api(app, developer, { method: 'GET', url: '/api/v1/auth/me' })
    expect(me.json().user.developer).toBe(true)

    const clientMe = await api(app, client, { method: 'GET', url: '/api/v1/auth/me' })
    expect(clientMe.json().user.developer).toBe(false)

    const users = await api(app, developer, { method: 'GET', url: '/api/v1/workspace/users' })
    expect(users.json().users[0].developer).toBe(true)
  })
})

describe('platform credentials (developer-only)', () => {
  it('locks every platform credential endpoint away from non-developers', async () => {
    for (const session of [client, clientMember]) {
      const get = await api(app, session, { method: 'GET', url: '/api/v1/platform/credentials' })
      expect(get.statusCode).toBe(403)
      const put = await api(app, session, {
        method: 'PUT',
        url: '/api/v1/platform/credentials/ANTHROPIC_API_KEY',
        payload: { value: 'sk-ant-nope' },
      })
      expect(put.statusCode).toBe(403)
      expect(put.json().error).toMatch(/developer/i)
    }
  })

  it('stores the universal Anthropic key encrypted and masked', async () => {
    const secret = 'sk-ant-universal-platform-key-7777'
    const put = await api(app, developer, {
      method: 'PUT',
      url: '/api/v1/platform/credentials/ANTHROPIC_API_KEY',
      payload: { value: secret },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().maskedValue).toBe('sk-…7777')

    const list = await api(app, developer, { method: 'GET', url: '/api/v1/platform/credentials' })
    expect(JSON.stringify(list.json())).not.toContain(secret)

    const row = await app.prisma.platformCredential.findUniqueOrThrow({ where: { kind: 'ANTHROPIC_API_KEY' } })
    expect(row.encryptedValue).not.toContain(secret)
  })

  it('requires meta.clientId on the Google OAuth client', async () => {
    const missing = await api(app, developer, {
      method: 'PUT',
      url: '/api/v1/platform/credentials/GOOGLE_OAUTH_CLIENT',
      payload: { value: 'google-client-secret-1' },
    })
    expect(missing.statusCode).toBe(400)

    const ok = await api(app, developer, {
      method: 'PUT',
      url: '/api/v1/platform/credentials/GOOGLE_OAUTH_CLIENT',
      payload: { value: 'google-client-secret-1', meta: { clientId: 'test-client-id.apps.googleusercontent.com' } },
    })
    expect(ok.statusCode).toBe(200)
  })

  it('rejects unknown platform kinds', async () => {
    const res = await api(app, developer, {
      method: 'PUT',
      url: '/api/v1/platform/credentials/SOMETHING_ELSE',
      payload: { value: 'x' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('client-facing lockdown', () => {
  it('workspace credential PUT is developer-only now', async () => {
    const res = await api(app, client, {
      method: 'PUT',
      url: '/api/v1/workspace/credentials/GMAIL_IMAP',
      payload: { value: 'app-password', meta: { email: 'x@client.test' } },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatch(/developer/i)
  })

  it('ingest API keys are developer-only, even for the workspace OWNER', async () => {
    const list = await api(app, client, { method: 'GET', url: '/api/v1/workspace/api-keys' })
    expect(list.statusCode).toBe(403)
    const create = await api(app, client, { method: 'POST', url: '/api/v1/workspace/api-keys', payload: { name: 'k' } })
    expect(create.statusCode).toBe(403)
  })
})

describe('Gmail connect (sign-in) flow', () => {
  it('returns the Google consent URL for OWNER/ADMIN once the platform client exists', async () => {
    const res = await api(app, client, { method: 'POST', url: '/api/v1/workspace/gmail/connect' })
    expect(res.statusCode).toBe(200)
    const url = new URL(res.json().url)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('test-client-id.apps.googleusercontent.com')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/api/v1/auth/google/callback')
    expect(url.searchParams.get('scope')).toContain('https://mail.google.com/')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('state')).toBeTruthy()
  })

  it('MEMBERs cannot start a connect', async () => {
    const res = await api(app, clientMember, { method: 'POST', url: '/api/v1/workspace/gmail/connect' })
    expect(res.statusCode).toBe(403)
  })

  it('the callback rejects a bad state token with an error redirect', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=abc&state=garbage' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain('gmail=error')
  })

  it('a valid callback stores the refresh token as GMAIL_OAUTH and redirects to settings', async () => {
    const restore = setGoogleOauthDepsForTesting({
      exchangeCode: async ({ code }) => {
        expect(code).toBe('good-code')
        return { refreshToken: 'google-refresh-token-1', accessToken: 'at-1', email: 'inbox@client.test' }
      },
      refreshAccessToken: async () => 'unused',
    })
    try {
      const state = signGmailConnectToken(
        { workspaceId: client.workspace.id, userId: client.user.id },
        testConfig(ENV),
      )
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/google/callback?code=good-code&state=${encodeURIComponent(state)}`,
      })
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toContain('gmail=connected')
    } finally {
      restore()
    }

    const row = await app.prisma.credential.findUniqueOrThrow({
      where: { workspaceId_kind: { workspaceId: client.workspace.id, kind: 'GMAIL_OAUTH' } },
    })
    expect((row.meta as { email: string }).email).toBe('inbox@client.test')
    expect(row.encryptedValue).not.toContain('google-refresh-token-1')

    const status = await api(app, client, { method: 'GET', url: '/api/v1/workspace/scan/status' })
    expect(status.json()).toMatchObject({
      configured: true,
      method: 'oauth',
      email: 'inbox@client.test',
      googleSignInAvailable: true,
      aiReady: true,
    })
  })

  it('scans over OAuth: trades the refresh token for an access token, no password involved', async () => {
    const seen: MailboxConfig[] = []
    const email: InboundEmail = {
      messageId: '<oauth-1@mail.example>',
      from: { name: 'Pat Suarez', address: 'pat@prospect.example' },
      to: ['inbox@client.test'],
      subject: 'Consulting inquiry',
      date: new Date('2026-07-15T09:00:00Z'),
      text: 'We need help with an AI rollout.',
      references: [],
      inReplyTo: null,
    }
    const scored: ScoredLead = {
      relevant: true,
      name: 'Pat Suarez',
      org: 'Prospect LLC',
      inquiryType: 'Other',
      summary: 'Wants AI rollout help.',
      fitScore: 7,
      urgencyScore: 5,
      leadScore: 7,
      dealValueLow: 2000,
      dealValueHigh: 4000,
      estPayoutRaw: '$2–4k',
      estWork: '~1 week',
      recommendedNextStep: 'Reply with a call slot.',
      draftReply: 'Hi Pat…',
      fitReasons: ['Direct ask'],
      riskFlags: [],
      inferredFields: [],
    }
    const restoreGoogle = setGoogleOauthDepsForTesting({
      exchangeCode: async () => {
        throw new Error('not used here')
      },
      refreshAccessToken: async ({ refreshToken }) => {
        expect(refreshToken).toBe('google-refresh-token-1')
        return 'short-lived-access-token'
      },
    })
    const restoreScan = setScanDepsForTesting({
      fetchEmails: async (mailbox) => {
        seen.push(mailbox)
        return [email]
      },
      fetchSentEmails: async () => [],
      scoreEmail: async () => scored,
      listMeetings: async () => [],
      getMeetingInsight: async () => ({ tldr: '', text: '' }),
      classifyEmail: async () => ({ decision: 'unsure', confidence: 0.5, reason: 'test' }),
    })
    try {
      const result = await runScan(app.prisma, testConfig(ENV), client.workspace.id)
      expect(result.imported).toBe(1)
      expect(result.errors).toEqual([])
    } finally {
      restoreScan()
      restoreGoogle()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ user: 'inbox@client.test', accessToken: 'short-lived-access-token' })
    expect(seen[0]!.pass).toBeUndefined()

    const list = await api(app, client, { method: 'GET', url: '/api/v1/leads?pageSize=10' })
    expect(list.json().total).toBe(1)
    expect(list.json().items[0].source).toBe('Email')
  })

  it('disconnecting the mailbox is a client action and un-configures scanning', async () => {
    const del = await api(app, client, { method: 'DELETE', url: '/api/v1/workspace/credentials/GMAIL_OAUTH' })
    expect(del.statusCode).toBe(200)

    const status = await api(app, client, { method: 'GET', url: '/api/v1/workspace/scan/status' })
    expect(status.json().configured).toBe(false)
    expect(status.json().method).toBeNull()
    // The sign-in stays available for reconnecting.
    expect(status.json().googleSignInAvailable).toBe(true)
  })
})
