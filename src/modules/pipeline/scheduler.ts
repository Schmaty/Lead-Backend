import type { FastifyInstance } from 'fastify'
import { resolveSettings } from '../../types/settings.js'
import { getScanState, GMAIL_IMAP_KIND, GMAIL_OAUTH_KIND, resolveScanSetup, runScan } from './scanner.js'

const TICK_MS = 60_000

/**
 * Background scan scheduler: every minute, run a scan for each workspace whose
 * configured poll interval has elapsed. Started from server.ts (not in tests).
 */
export function startScanScheduler(app: FastifyInstance): () => void {
  const tick = async (): Promise<void> => {
    const mailboxCredentials = await app.prisma.credential.findMany({
      where: { kind: { in: [GMAIL_OAUTH_KIND, GMAIL_IMAP_KIND] } },
      select: { workspaceId: true },
    })
    const workspaceIds = [...new Set(mailboxCredentials.map((c) => c.workspaceId))]
    for (const workspaceId of workspaceIds) {
      try {
        if (getScanState(workspaceId).running) continue
        const { credentials } = await resolveScanSetup(app.prisma, app.config, workspaceId)
        if (!credentials) continue
        const workspace = await app.prisma.workspace.findUnique({ where: { id: workspaceId } })
        if (!workspace) continue
        const pollMs = resolveSettings(workspace.settings).scanSettings.pollMinutes * 60_000
        const due = !credentials.lastScanAt || Date.now() - credentials.lastScanAt.getTime() >= pollMs
        if (!due) continue
        app.log.info({ workspaceId }, 'starting scheduled inbox scan')
        const result = await runScan(app.prisma, app.config, workspaceId)
        app.log.info({ workspaceId, ...result }, 'scheduled inbox scan finished')
      } catch (err) {
        app.log.error({ err, workspaceId }, 'scheduled inbox scan failed')
      }
    }
  }

  const interval = setInterval(() => {
    void tick().catch((err) => app.log.error({ err }, 'scan scheduler tick failed'))
  }, TICK_MS)
  interval.unref()
  return () => clearInterval(interval)
}
