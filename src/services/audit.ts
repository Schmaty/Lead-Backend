import type { PrismaClient } from '@prisma/client'

export interface AuditEntry {
  workspaceId: string
  userId?: string | null
  action: string
  target: string
  ip?: string | null
}

/** Append an audit-log row. Never throws — auditing must not break the request. */
export async function audit(prisma: PrismaClient, entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        workspaceId: entry.workspaceId,
        userId: entry.userId ?? null,
        action: entry.action,
        target: entry.target,
        ip: entry.ip ?? null,
      },
    })
  } catch {
    // swallow — an audit failure must not fail the underlying operation
  }
}
