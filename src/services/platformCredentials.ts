import type { PrismaClient } from '@prisma/client'
import type { AppConfig } from '../config.js'
import { decryptSecret } from '../crypto/secrets.js'

/**
 * Platform-wide secrets, managed only by the developer account:
 * - ANTHROPIC_API_KEY: one universal key that scores every workspace's mail
 *   (the platform absorbs the Anthropic bill). meta.model optionally picks
 *   the Claude model the scorer uses.
 * - GOOGLE_OAUTH_CLIENT: the Google OAuth app clients sign in through.
 *   value = client secret, meta.clientId = client ID.
 * - AMBIENT_API_KEY: the meeting-transcript provider (ambient.us) API key.
 *   meta.baseUrl overrides the default API host.
 * - ZOHO_CRM: value = JSON {"clientSecret","refreshToken"}; meta = { clientId,
 *   accountsUrl?, apiDomain? }. Current tokens are read-only — pushing to the
 *   CRM ships later and will need a WRITE-scoped token.
 */
export const PLATFORM_CREDENTIAL_KINDS = ['ANTHROPIC_API_KEY', 'GOOGLE_OAUTH_CLIENT', 'AMBIENT_API_KEY', 'ZOHO_CRM'] as const
export type PlatformCredentialKind = (typeof PLATFORM_CREDENTIAL_KINDS)[number]

/** Models the developer may pick for the scorer (Settings → Platform). */
export const SCORER_MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as const
export const DEFAULT_SCORER_MODEL = 'claude-opus-4-8'

export interface GoogleOauthClient {
  clientId: string
  clientSecret: string
}

export async function getPlatformSecret(
  prisma: PrismaClient,
  config: AppConfig,
  kind: PlatformCredentialKind,
): Promise<{ value: string; meta: Record<string, unknown> } | null> {
  const credential = await prisma.platformCredential.findUnique({ where: { kind } })
  if (!credential) return null
  try {
    return {
      value: decryptSecret(credential.encryptedValue, config.encryptionKey),
      meta: (credential.meta ?? {}) as Record<string, unknown>,
    }
  } catch {
    return null
  }
}

/** The universal Anthropic key every workspace's scanner scores with. */
export async function getPlatformAnthropicKey(prisma: PrismaClient, config: AppConfig): Promise<string | null> {
  const secret = await getPlatformSecret(prisma, config, 'ANTHROPIC_API_KEY')
  return secret?.value ?? null
}

/** The Google OAuth app (client ID + secret) clients sign in through. */
export async function getGoogleOauthClient(prisma: PrismaClient, config: AppConfig): Promise<GoogleOauthClient | null> {
  const secret = await getPlatformSecret(prisma, config, 'GOOGLE_OAUTH_CLIENT')
  if (!secret) return null
  const clientId = typeof secret.meta.clientId === 'string' ? secret.meta.clientId : ''
  if (!clientId) return null
  return { clientId, clientSecret: secret.value }
}

/** The Claude model the scorer runs — developer-picked, stored on the key's meta. */
export async function getScorerModel(prisma: PrismaClient, config: AppConfig): Promise<string> {
  const secret = await getPlatformSecret(prisma, config, 'ANTHROPIC_API_KEY')
  const model = typeof secret?.meta.model === 'string' ? secret.meta.model : ''
  return (SCORER_MODELS as readonly string[]).includes(model) ? model : DEFAULT_SCORER_MODEL
}

export interface AmbientConfig {
  apiKey: string
  baseUrl: string
}

/** The meeting-transcript provider credentials (ambient.us). */
export async function getAmbientConfig(prisma: PrismaClient, config: AppConfig): Promise<AmbientConfig | null> {
  const secret = await getPlatformSecret(prisma, config, 'AMBIENT_API_KEY')
  if (!secret) return null
  const baseUrl = typeof secret.meta.baseUrl === 'string' && secret.meta.baseUrl ? secret.meta.baseUrl : 'https://api.ambient.us/v1'
  return { apiKey: secret.value, baseUrl: baseUrl.replace(/\/$/, '') }
}

export interface ZohoConfig {
  clientId: string
  clientSecret: string
  refreshToken: string
  accountsUrl: string
  apiDomain: string
}

/** The Zoho CRM connection (value = JSON {clientSecret, refreshToken}). */
export async function getZohoConfig(prisma: PrismaClient, config: AppConfig): Promise<ZohoConfig | null> {
  const secret = await getPlatformSecret(prisma, config, 'ZOHO_CRM')
  if (!secret) return null
  const clientId = typeof secret.meta.clientId === 'string' ? secret.meta.clientId : ''
  if (!clientId) return null
  let parsed: { clientSecret?: string; refreshToken?: string }
  try {
    parsed = JSON.parse(secret.value) as { clientSecret?: string; refreshToken?: string }
  } catch {
    return null
  }
  if (!parsed.clientSecret || !parsed.refreshToken) return null
  return {
    clientId,
    clientSecret: parsed.clientSecret,
    refreshToken: parsed.refreshToken,
    accountsUrl: (typeof secret.meta.accountsUrl === 'string' && secret.meta.accountsUrl) || 'https://accounts.zoho.com',
    apiDomain: (typeof secret.meta.apiDomain === 'string' && secret.meta.apiDomain) || 'https://www.zohoapis.com',
  }
}
