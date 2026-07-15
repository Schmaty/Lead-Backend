import type { FastifyRequest } from 'fastify'
import { AppError } from './errorHandler.js'

/**
 * Workspace scoping: every business-data query must be filtered by the
 * caller's workspaceId. Handlers get it exclusively through this helper so a
 * missing auth context is a hard failure, never an unscoped query.
 */
export function workspaceId(request: FastifyRequest): string {
  const id = request.auth?.workspaceId ?? request.ingest?.workspaceId
  if (!id) throw new AppError(401, 'Not authenticated')
  return id
}
