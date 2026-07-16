import type { FastifyInstance } from 'fastify'
import { authGuard, requireRole } from '../../middleware/authGuard.js'
import { AppError } from '../../middleware/errorHandler.js'
import { workspaceId } from '../../middleware/workspaceScope.js'
import { audit } from '../../services/audit.js'
import { resolveSettings } from '../../types/settings.js'
import { getScanState, loadScanCredentials, runScan } from './scanner.js'

/** Inbox-scanning pipeline: trigger + status. Registered under /workspace. */
export default async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app
  const guard = authGuard(app)

  // ── Kick off a scan now (runs in the background; poll status) ────────────
  app.post('/scan', { preHandler: [guard, requireRole('OWNER', 'ADMIN')] }, async (request, reply) => {
    const auth = request.auth!
    const wsId = workspaceId(request)
    const state = getScanState(wsId)
    if (state.running) throw new AppError(409, 'A scan is already running for this workspace')
    const credentials = await loadScanCredentials(prisma, config, wsId)
    if (!credentials) {
      throw new AppError(
        400,
        'Inbox scanning is not configured — store the Gmail mailbox and Anthropic API key credentials first',
      )
    }
    void runScan(prisma, config, wsId).catch((err) => {
      app.log.error({ err, workspaceId: wsId }, 'inbox scan failed')
    })
    await audit(prisma, { workspaceId: wsId, userId: auth.userId, action: 'pipeline.scan_started', target: 'inbox', ip: request.ip })
    return reply.status(202).send({ started: true })
  })

  // ── Scan status (any signed-in member) ───────────────────────────────────
  app.get('/scan/status', { preHandler: [guard] }, async (request) => {
    const wsId = workspaceId(request)
    const [credentials, workspace] = await Promise.all([
      loadScanCredentials(prisma, config, wsId),
      prisma.workspace.findUniqueOrThrow({ where: { id: wsId } }),
    ])
    const state = getScanState(wsId)
    return {
      configured: !!credentials,
      running: state.running,
      lastScanAt: credentials?.lastScanAt ?? null,
      pollMinutes: resolveSettings(workspace.settings).scanSettings.pollMinutes,
      lastResult: state.lastResult ?? null,
      lastError: state.lastError ?? null,
    }
  })
}
