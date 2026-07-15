import type { PrismaClient, User } from '@prisma/client'
import type { AppConfig } from '../config.js'
import { randomToken, sha256Hex } from '../crypto/hashing.js'

/** Create and persist a refresh token; only the sha256 hash is stored. */
export async function issueRefreshToken(
  prisma: PrismaClient,
  userId: string,
  config: AppConfig,
): Promise<{ raw: string; expiresAt: Date }> {
  const raw = randomToken(32)
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlSec * 1000)
  await prisma.refreshToken.create({
    data: { userId, tokenHash: sha256Hex(raw), expiresAt },
  })
  return { raw, expiresAt }
}

export type RotateResult =
  | { ok: true; user: User; raw: string }
  | { ok: false; reason: 'unknown' | 'expired' }
  | { ok: false; reason: 'reused'; user: User }

/**
 * Rotate a refresh token: revoke the presented one and issue a replacement.
 * Presenting an already-revoked token is treated as theft — every session for
 * that user is revoked.
 */
export async function rotateRefreshToken(
  prisma: PrismaClient,
  raw: string,
  config: AppConfig,
): Promise<RotateResult> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256Hex(raw) },
    include: { user: true },
  })
  if (!stored) return { ok: false, reason: 'unknown' }
  if (stored.revokedAt) {
    await revokeAllForUser(prisma, stored.userId)
    return { ok: false, reason: 'reused', user: stored.user }
  }
  if (stored.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'expired' }
  }
  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } })
  const next = await issueRefreshToken(prisma, stored.userId, config)
  return { ok: true, user: stored.user, raw: next.raw }
}

/** Revoke a refresh token by its raw value; returns the owning user if found. */
export async function revokeByRaw(prisma: PrismaClient, raw: string): Promise<User | null> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256Hex(raw) },
    include: { user: true },
  })
  if (!stored) return null
  if (!stored.revokedAt) {
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } })
  }
  return stored.user
}

export async function revokeAllForUser(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/** Derive a unique, URL-safe workspace slug from a display name. */
export async function uniqueSlug(prisma: PrismaClient, name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'workspace'
  let candidate = base
  for (let i = 2; ; i++) {
    const existing = await prisma.workspace.findUnique({ where: { slug: candidate } })
    if (!existing) return candidate
    candidate = `${base}-${i}`
  }
}
