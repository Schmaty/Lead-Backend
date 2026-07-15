import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'

// OWASP-recommended argon2id parameters (19 MiB memory, 2 iterations).
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** URL-safe random token (refresh tokens, etc.). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export const API_KEY_PREFIX_LENGTH = 8

/** Generate an ingest API key. The full key is shown once; only its sha256 is stored. */
export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const key = `llk_${randomBytes(30).toString('base64url')}`
  return { key, prefix: key.slice(0, API_KEY_PREFIX_LENGTH), keyHash: sha256Hex(key) }
}

/** Constant-time string comparison that tolerates length mismatches. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
