import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

/** Operational error with an HTTP status code; message is safe to show clients. */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }
    if (err instanceof AppError) {
      const body: Record<string, unknown> = { error: err.message }
      if (err.details !== undefined) body.details = err.details
      return reply.status(err.statusCode).send(body)
    }
    // Fastify-generated errors (rate limit 429, body too large 413, bad JSON 400, …)
    const known = err as Error & { statusCode?: number }
    const statusCode = typeof known.statusCode === 'number' ? known.statusCode : 500
    if (statusCode < 500) {
      return reply.status(statusCode).send({ error: known.message })
    }
    request.log.error({ err }, 'unhandled error')
    return reply.status(500).send({ error: 'Internal server error' })
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: 'Not found' })
  })
}
