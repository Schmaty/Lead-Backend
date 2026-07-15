import 'dotenv/config'
import { z } from 'zod'

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  databaseUrl: string
  encryptionKey: Buffer
  jwtAccessSecret: string
  jwtRefreshSecret: string
  accessTokenTtlSec: number
  refreshTokenTtlSec: number
  inviteTokenTtlSec: number
  resetTokenTtlSec: number
  corsOrigins: string[]
  cookieDomain: string | undefined
  cookieSecure: boolean
  cookieSameSite: 'lax' | 'strict' | 'none'
  rateLimitWindowMs: number
  rateLimitMax: number
  authRateLimitMax: number
  ingestRateLimitMax: number
  ingestHmacEnabled: boolean
  bodyLimitBytes: number
  smtpUrl: string | undefined
  smtpFrom: string
  logLevel: string
}

const DURATION_RE = /^(\d+)\s*(s|m|h|d)$/i
const DURATION_MULT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

export function parseDuration(value: string, name: string): number {
  const match = DURATION_RE.exec(value.trim())
  if (!match) {
    throw new Error(`${name} must be a duration like "45s", "15m", "12h" or "30d" (got "${value}")`)
  }
  return Number(match[1]) * DURATION_MULT[match[2]!.toLowerCase()]!
}

const boolString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().min(1, 'required — e.g. postgresql://leadline:pass@localhost:5432/leadline'),
  APP_ENCRYPTION_KEY: z.string().min(1, 'required — generate with: openssl rand -base64 32'),
  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters — generate with: openssl rand -base64 48'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters — generate with: openssl rand -base64 48'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),
  INVITE_TOKEN_TTL: z.string().default('7d'),
  RESET_TOKEN_TTL: z.string().default('1h'),
  CORS_ORIGIN: z.string().min(1, 'required — the dashboard origin, e.g. https://leadline.yourdomain.com'),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: boolString.optional(),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  RATE_LIMIT_WINDOW: z.string().default('1m'),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  INGEST_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  INGEST_HMAC_ENABLED: boolString.default('false'),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('Leadline <no-reply@localhost>'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

/**
 * Parse and validate configuration from environment variables.
 * Fails fast with a readable list of every problem found.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(env)'}: ${issue.message}`)
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}\nSee .env.example for documentation of every variable.`)
  }
  const raw = parsed.data

  const problems: string[] = []

  let encryptionKey = Buffer.alloc(0)
  try {
    encryptionKey = Buffer.from(raw.APP_ENCRYPTION_KEY, 'base64')
  } catch {
    /* handled below */
  }
  if (encryptionKey.length !== 32) {
    problems.push('  - APP_ENCRYPTION_KEY: must be exactly 32 bytes of base64 (generate with: openssl rand -base64 32)')
  }

  if (raw.JWT_ACCESS_SECRET === raw.JWT_REFRESH_SECRET) {
    problems.push('  - JWT_REFRESH_SECRET: must differ from JWT_ACCESS_SECRET')
  }

  const durations: Record<string, number> = {}
  for (const [key, value] of Object.entries({
    ACCESS_TOKEN_TTL: raw.ACCESS_TOKEN_TTL,
    REFRESH_TOKEN_TTL: raw.REFRESH_TOKEN_TTL,
    INVITE_TOKEN_TTL: raw.INVITE_TOKEN_TTL,
    RESET_TOKEN_TTL: raw.RESET_TOKEN_TTL,
    RATE_LIMIT_WINDOW: raw.RATE_LIMIT_WINDOW,
  })) {
    try {
      durations[key] = parseDuration(value, key)
    } catch (err) {
      problems.push(`  - ${(err as Error).message}`)
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}\nSee .env.example for documentation of every variable.`)
  }

  const corsOrigins = raw.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  return {
    nodeEnv: raw.NODE_ENV,
    host: raw.HOST,
    port: raw.PORT,
    databaseUrl: raw.DATABASE_URL,
    encryptionKey,
    jwtAccessSecret: raw.JWT_ACCESS_SECRET,
    jwtRefreshSecret: raw.JWT_REFRESH_SECRET,
    accessTokenTtlSec: durations.ACCESS_TOKEN_TTL!,
    refreshTokenTtlSec: durations.REFRESH_TOKEN_TTL!,
    inviteTokenTtlSec: durations.INVITE_TOKEN_TTL!,
    resetTokenTtlSec: durations.RESET_TOKEN_TTL!,
    corsOrigins,
    cookieDomain: raw.COOKIE_DOMAIN || undefined,
    cookieSecure: raw.COOKIE_SECURE ?? raw.NODE_ENV === 'production',
    cookieSameSite: raw.COOKIE_SAMESITE,
    rateLimitWindowMs: durations.RATE_LIMIT_WINDOW! * 1000,
    rateLimitMax: raw.RATE_LIMIT_MAX,
    authRateLimitMax: raw.AUTH_RATE_LIMIT_MAX,
    ingestRateLimitMax: raw.INGEST_RATE_LIMIT_MAX,
    ingestHmacEnabled: raw.INGEST_HMAC_ENABLED,
    bodyLimitBytes: raw.BODY_LIMIT_BYTES,
    smtpUrl: raw.SMTP_URL || undefined,
    smtpFrom: raw.SMTP_FROM,
    logLevel: raw.LOG_LEVEL,
  }
}
