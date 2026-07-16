import type { PrismaClient } from '@prisma/client'
import type { AppConfig } from '../config.js'
import { decryptSecret } from '../crypto/secrets.js'

/**
 * Platform-wide secrets, managed only by the developer account:
 * - ANTHROPIC_API_KEY: one universal key that scores every workspace's mail
 *   (the platform absorbs the Anthropic bill).
 * - GOOGLE_OAUTH_CLIENT: the Google OAuth app clients sign in through.
 *   value = client secret, meta.clientId = client ID.
 */
export const PLATFORM_CREDENTIAL_KINDS = ['ANTHROPIC_API_KEY', 'GOOGLE_OAUTH_CLIENT'] as const
export type PlatformCredentialKind = (typeof PLATFORM_CREDENTIAL_KINDS)[number]

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
