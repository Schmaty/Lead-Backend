import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig, type AppConfig } from '../src/config.js'

export const TEST_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')

export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const databaseUrl = process.env.TEST_DATABASE_URL
  if (!databaseUrl) {
    throw new Error('TEST_DATABASE_URL is not set — the vitest globalSetup should have started embedded Postgres')
  }
  return {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    APP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0001',
    JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-01',
    CORS_ORIGIN: 'http://localhost:5173',
    REFRESH_REUSE_GRACE: '0s',
    RATE_LIMIT_MAX: '1000000',
    AUTH_RATE_LIMIT_MAX: '1000000',
    INGEST_RATE_LIMIT_MAX: '1000000',
    LOG_LEVEL: 'silent',
    ...overrides,
  }
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(testEnv(overrides))
}

export async function makeApp(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const app = await buildApp(testConfig(overrides))
  await app.ready()
  return app
}

export async function resetDb(app: FastifyInstance): Promise<void> {
  await app.prisma.$executeRawUnsafe(
    'TRUNCATE "Workspace","User","RefreshToken","Lead","Thread","TimelineEvent","Credential","ApiKey","AuditLog","PlatformCredential" CASCADE',
  )
}

export interface Session {
  accessToken: string
  refreshCookie: string
  user: { id: string; email: string; role: string; name: string }
  workspace: { id: string; name: string; slug: string; settings: Record<string, unknown> }
}

export function extractRefreshCookie(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie']
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  const refresh = cookies.find((cookie) => cookie.startsWith('leadline_refresh='))
  if (!refresh) throw new Error(`no refresh cookie in response (status ${res.statusCode})`)
  return refresh.split(';')[0]!
}

export async function signup(
  app: FastifyInstance,
  options: { workspaceName?: string; name?: string; email: string; password?: string },
): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: {
      workspaceName: options.workspaceName ?? 'Test Workspace',
      name: options.name ?? 'Test User',
      email: options.email,
      password: options.password ?? 'correct-horse-battery-staple-42',
    },
  })
  if (res.statusCode !== 201) {
    throw new Error(`signup failed (${res.statusCode}): ${res.body}`)
  }
  const body = res.json()
  return {
    accessToken: body.accessToken,
    refreshCookie: extractRefreshCookie(res),
    user: body.user,
    workspace: body.workspace,
  }
}

export function bearer(session: Session): Record<string, string> {
  return { authorization: `Bearer ${session.accessToken}` }
}

export async function api(
  app: FastifyInstance,
  session: Session | null,
  options: InjectOptions,
): Promise<LightMyRequestResponse> {
  return app.inject({
    ...options,
    headers: { ...(session ? bearer(session) : {}), ...(options.headers ?? {}) },
  })
}

/** Create a MEMBER in the session's workspace via the invite flow. */
export async function addMember(
  app: FastifyInstance,
  owner: Session,
  email: string,
  role: 'ADMIN' | 'MEMBER' = 'MEMBER',
): Promise<Session> {
  const inviteRes = await api(app, owner, {
    method: 'POST',
    url: '/api/v1/auth/invite',
    payload: { email, role },
  })
  if (inviteRes.statusCode !== 200) throw new Error(`invite failed: ${inviteRes.body}`)
  const { token } = inviteRes.json()
  const acceptRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/accept-invite',
    payload: { token, name: `Member ${email}`, password: 'invitee-passphrase-okay-99' },
  })
  if (acceptRes.statusCode !== 201) throw new Error(`accept-invite failed: ${acceptRes.body}`)
  const body = acceptRes.json()
  return {
    accessToken: body.accessToken,
    refreshCookie: extractRefreshCookie(acceptRes),
    user: body.user,
    workspace: body.workspace,
  }
}

/** Create a lead through the API (defaults are valid; override freely). */
export async function createLead(
  app: FastifyInstance,
  session: Session,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const res = await api(app, session, {
    method: 'POST',
    url: '/api/v1/leads',
    payload: {
      name: 'Test Lead',
      email: 'lead@example.test',
      ...overrides,
    },
  })
  if (res.statusCode !== 201) throw new Error(`createLead failed (${res.statusCode}): ${res.body}`)
  return res.json()
}

export const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()
export const daysFromNow = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString()
