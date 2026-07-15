import type { PrismaClient, Role } from '@prisma/client'
import type { AppConfig } from '../config.js'

export interface AuthContext {
  userId: string
  workspaceId: string
  role: Role
  name: string
  email: string
}

export interface IngestContext {
  workspaceId: string
  apiKeyId: string
}

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
    config: AppConfig
  }
  interface FastifyRequest {
    auth?: AuthContext
    ingest?: IngestContext
    rawBody?: Buffer
  }
}
