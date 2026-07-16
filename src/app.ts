import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import type { AppConfig } from './config.js'
import { createPrisma } from './db.js'
import authRoutes from './auth/routes.js'
import { registerErrorHandling } from './middleware/errorHandler.js'
import analyticsRoutes from './modules/analytics/routes.js'
import ingestRoutes from './modules/ingest/routes.js'
import leadsRoutes from './modules/leads/routes.js'
import pipelineRoutes, { googleCallbackRoutes } from './modules/pipeline/routes.js'
import platformRoutes from './modules/platform/routes.js'
import workspaceRoutes from './modules/workspace/routes.js'
import './types/augment.js'

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'req.headers["x-signature"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: config.bodyLimitBytes,
    trustProxy: true,
    disableRequestLogging: config.nodeEnv === 'test',
  })

  const prisma = createPrisma(config.databaseUrl)
  app.decorate('config', config)
  app.decorate('prisma', prisma)
  app.addHook('onClose', async () => {
    await prisma.$disconnect()
  })

  // JSON parser that keeps the raw body so the ingest HMAC can be verified.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body: Buffer, done) => {
    request.rawBody = body
    if (body.length === 0) {
      done(null, undefined)
      return
    }
    try {
      done(null, JSON.parse(body.toString('utf8')))
    } catch {
      const err = new Error('Invalid JSON body') as Error & { statusCode: number }
      err.statusCode = 400
      done(err, undefined)
    }
  })

  await app.register(cookie)
  await app.register(cors, { origin: config.corsOrigins, credentials: true })
  await app.register(helmet)
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    allowList: (request) => request.url === '/health' || request.url === '/ready',
  })
  registerErrorHandling(app)

  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/ready', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return { status: 'ready' }
    } catch {
      return reply.status(503).send({ status: 'unavailable' })
    }
  })

  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.register(googleCallbackRoutes, { prefix: '/api/v1/auth' })
  await app.register(workspaceRoutes, { prefix: '/api/v1/workspace' })
  await app.register(pipelineRoutes, { prefix: '/api/v1/workspace' })
  await app.register(platformRoutes, { prefix: '/api/v1/platform' })
  await app.register(leadsRoutes, { prefix: '/api/v1/leads' })
  await app.register(analyticsRoutes, { prefix: '/api/v1/analytics' })
  await app.register(ingestRoutes, { prefix: '/api/v1/ingest' })

  return app
}
