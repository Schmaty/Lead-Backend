import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { startScanScheduler } from './modules/pipeline/scheduler.js'

async function main(): Promise<void> {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error((err as Error).message)
    process.exit(1)
  }

  const app = await buildApp(config)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, 'shutting down gracefully')
    try {
      await app.close()
      process.exit(0)
    } catch (err) {
      app.log.error({ err }, 'error during shutdown')
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Built-in inbox scanning: polls each configured workspace's mailbox on its
  // scanSettings.pollMinutes cadence. Wired before listen() — Fastify rejects
  // addHook once the instance is listening.
  const stopScheduler = startScanScheduler(app)
  app.addHook('onClose', async () => stopScheduler())

  try {
    await app.listen({ host: config.host, port: config.port })
  } catch (err) {
    app.log.error({ err }, 'failed to start')
    process.exit(1)
  }
}

void main()
