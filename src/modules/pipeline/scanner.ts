import type { PrismaClient } from '@prisma/client'
import type { AppConfig } from '../../config.js'
import { decryptSecret } from '../../crypto/secrets.js'
import { AppError } from '../../middleware/errorHandler.js'
import { upsertLeadByExternalId } from '../../services/leadUpsert.js'
import {
  getGoogleOauthClient,
  getPlatformAnthropicKey,
  type GoogleOauthClient,
} from '../../services/platformCredentials.js'
import { resolveSettings, type WorkspaceSettings } from '../../types/settings.js'
import { googleOauth } from './googleOauth.js'
import { fetchRecentEmails, type InboundEmail, type MailboxConfig } from './mailbox.js'
import { createAnthropic, scoreEmail, type ScoredLead } from './scorer.js'

/** Client sign-in path: value = Google refresh token, meta = { email, lastScanAt }. */
export const GMAIL_OAUTH_KIND = 'GMAIL_OAUTH'
/** Fallback path (developer-managed): value = app password, meta = { email, host?, port?, lastScanAt }. */
export const GMAIL_IMAP_KIND = 'GMAIL_IMAP'
/** Pre-platform installs stored the Anthropic key per workspace; still honored as a fallback. */
const LEGACY_ANTHROPIC_KIND = 'ANTHROPIC_API_KEY'

const DEFAULT_IMAP_HOST = 'imap.gmail.com'
const DEFAULT_IMAP_PORT = 993
/** Cap per scan so one run can't burn unbounded Anthropic spend. */
const MAX_EMAILS_PER_SCAN = 25
/** First-ever scan looks back this far. */
const FIRST_SCAN_LOOKBACK_MS = 7 * 24 * 3600 * 1000
/** Subsequent scans re-read a little history; the idempotent upsert dedupes. */
const RESCAN_OVERLAP_MS = 60 * 60 * 1000

export interface ScanResult {
  at: string
  scanned: number
  imported: number
  updated: number
  skipped: number
  errors: string[]
}

interface ScanState {
  running: boolean
  lastResult?: ScanResult
  lastError?: string
}

const scanStates = new Map<string, ScanState>()

export function getScanState(workspaceId: string): ScanState {
  let state = scanStates.get(workspaceId)
  if (!state) {
    state = { running: false }
    scanStates.set(workspaceId, state)
  }
  return state
}

export interface ScanDeps {
  fetchEmails: (config: MailboxConfig, since: Date, limit: number) => Promise<InboundEmail[]>
  scoreEmail: (
    apiKey: string,
    email: InboundEmail,
    settings: WorkspaceSettings,
    workspaceName: string,
  ) => Promise<ScoredLead>
}

let defaultDeps: ScanDeps = {
  fetchEmails: fetchRecentEmails,
  scoreEmail: (apiKey, email, settings, workspaceName) =>
    scoreEmail(createAnthropic(apiKey), email, settings, workspaceName),
}

/** Test hook: swap the IMAP/Anthropic edges for fakes. Returns a restore fn. */
export function setScanDepsForTesting(deps: ScanDeps): () => void {
  const previous = defaultDeps
  defaultDeps = deps
  return () => {
    defaultDeps = previous
  }
}

/** What the status endpoint (and the dashboard) needs to render the connect flow. */
export interface ScanConfigInfo {
  configured: boolean
  method: 'oauth' | 'imap' | null
  email: string | null
  /** True when the developer has stored the platform Google OAuth client. */
  googleSignInAvailable: boolean
  /** True when a platform (or legacy workspace) Anthropic key exists. */
  aiReady: boolean
  lastScanAt: Date | null
}

interface ScanCredentials {
  method: 'oauth' | 'imap'
  email: string
  host: string
  port: number
  anthropicApiKey: string
  /** The workspace credential row that carries the lastScanAt cursor in meta. */
  credentialId: string
  lastScanAt: Date | null
  /** oauth method */
  refreshToken?: string
  googleClient?: GoogleOauthClient
  /** imap method */
  pass?: string
}

interface CredentialMeta {
  email?: string
  host?: string
  port?: number
  lastScanAt?: string
}

/**
 * Resolve how (and whether) this workspace can scan. Mailbox: the OAuth
 * sign-in connection wins; the developer-managed app-password credential is
 * the fallback. AI: the platform key (universal, developer-managed) wins; a
 * legacy per-workspace key still works.
 */
export async function resolveScanSetup(
  prisma: PrismaClient,
  config: AppConfig,
  workspaceId: string,
): Promise<{ info: ScanConfigInfo; credentials: ScanCredentials | null }> {
  const [oauthCred, imapCred, legacyAnthropic, platformKey, googleClient] = await Promise.all([
    prisma.credential.findUnique({ where: { workspaceId_kind: { workspaceId, kind: GMAIL_OAUTH_KIND } } }),
    prisma.credential.findUnique({ where: { workspaceId_kind: { workspaceId, kind: GMAIL_IMAP_KIND } } }),
    prisma.credential.findUnique({ where: { workspaceId_kind: { workspaceId, kind: LEGACY_ANTHROPIC_KIND } } }),
    getPlatformAnthropicKey(prisma, config),
    getGoogleOauthClient(prisma, config),
  ])

  let anthropicApiKey = platformKey
  if (!anthropicApiKey && legacyAnthropic) {
    try {
      anthropicApiKey = decryptSecret(legacyAnthropic.encryptedValue, config.encryptionKey)
    } catch {
      anthropicApiKey = null
    }
  }

  const oauthMeta = (oauthCred?.meta ?? {}) as CredentialMeta
  const imapMeta = (imapCred?.meta ?? {}) as CredentialMeta

  let credentials: ScanCredentials | null = null
  if (oauthCred && oauthMeta.email && googleClient && anthropicApiKey) {
    credentials = {
      method: 'oauth',
      email: oauthMeta.email,
      host: DEFAULT_IMAP_HOST,
      port: DEFAULT_IMAP_PORT,
      anthropicApiKey,
      credentialId: oauthCred.id,
      lastScanAt: oauthMeta.lastScanAt ? new Date(oauthMeta.lastScanAt) : null,
      refreshToken: decryptSecret(oauthCred.encryptedValue, config.encryptionKey),
      googleClient,
    }
  } else if (imapCred && imapMeta.email && anthropicApiKey) {
    credentials = {
      method: 'imap',
      email: imapMeta.email,
      host: imapMeta.host || DEFAULT_IMAP_HOST,
      port: imapMeta.port || DEFAULT_IMAP_PORT,
      anthropicApiKey,
      credentialId: imapCred.id,
      lastScanAt: imapMeta.lastScanAt ? new Date(imapMeta.lastScanAt) : null,
      pass: decryptSecret(imapCred.encryptedValue, config.encryptionKey),
    }
  }

  const connectedMethod = oauthCred && oauthMeta.email && googleClient ? 'oauth' : imapCred && imapMeta.email ? 'imap' : null
  const connectedMeta = connectedMethod === 'oauth' ? oauthMeta : connectedMethod === 'imap' ? imapMeta : null
  return {
    info: {
      configured: credentials !== null,
      method: connectedMethod,
      email: connectedMeta?.email ?? null,
      googleSignInAvailable: googleClient !== null,
      aiReady: anthropicApiKey !== null,
      lastScanAt: connectedMeta?.lastScanAt ? new Date(connectedMeta.lastScanAt) : null,
    },
    credentials,
  }
}

/**
 * Scan the workspace inbox: fetch new mail over IMAP, score each message with
 * Claude, and upsert leads (idempotent by Message-ID). Human edits and manual
 * winProbability overrides on existing leads survive re-scans.
 */
export async function runScan(
  prisma: PrismaClient,
  config: AppConfig,
  workspaceId: string,
  deps: ScanDeps = defaultDeps,
): Promise<ScanResult> {
  const state = getScanState(workspaceId)
  if (state.running) throw new AppError(409, 'A scan is already running for this workspace')

  const { credentials } = await resolveScanSetup(prisma, config, workspaceId)
  if (!credentials) {
    throw new AppError(
      400,
      'Inbox scanning is not configured — connect the Gmail inbox, and make sure the platform AI key is set',
    )
  }

  state.running = true
  state.lastError = undefined
  const startedAt = new Date()
  try {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    const settings = resolveSettings(workspace.settings)
    const since = credentials.lastScanAt
      ? new Date(credentials.lastScanAt.getTime() - RESCAN_OVERLAP_MS)
      : new Date(startedAt.getTime() - FIRST_SCAN_LOOKBACK_MS)

    const mailbox: MailboxConfig = { host: credentials.host, port: credentials.port, user: credentials.email }
    if (credentials.method === 'oauth') {
      mailbox.accessToken = await googleOauth.refreshAccessToken({
        clientId: credentials.googleClient!.clientId,
        clientSecret: credentials.googleClient!.clientSecret,
        refreshToken: credentials.refreshToken!,
      })
    } else {
      mailbox.pass = credentials.pass
    }

    const emails = await deps.fetchEmails(mailbox, since, MAX_EMAILS_PER_SCAN)

    const result: ScanResult = { at: startedAt.toISOString(), scanned: emails.length, imported: 0, updated: 0, skipped: 0, errors: [] }
    for (const email of emails) {
      // Never score the workspace's own outbound mail that lands in INBOX.
      if (email.from.address === credentials.email.toLowerCase()) {
        result.skipped++
        continue
      }
      try {
        const scored = await deps.scoreEmail(credentials.anthropicApiKey, email, settings, workspace.name)
        const spamStage = settings.stages.find((s) => /spam/i.test(s))
        const { created } = await upsertLeadByExternalId(prisma, workspaceId, settings, {
          externalId: email.messageId,
          receivedAt: email.date,
          name: scored.name || email.from.name || email.from.address,
          email: email.from.address || 'unknown@unknown.invalid',
          org: scored.org,
          source: 'Email',
          inquiryType: scored.inquiryType,
          summary: scored.summary,
          fitScore: scored.fitScore,
          urgencyScore: scored.urgencyScore,
          leadScore: scored.leadScore,
          dealValueLow: scored.dealValueLow,
          dealValueHigh: scored.dealValueHigh,
          estPayoutRaw: scored.estPayoutRaw,
          estWork: scored.estWork,
          recommendedNextStep: scored.recommendedNextStep,
          draftReply: scored.draftReply,
          fitReasons: scored.fitReasons,
          riskFlags: scored.riskFlags,
          inferredFields: scored.inferredFields,
          threads: [
            {
              subject: email.subject,
              url: `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(email.messageId)}`,
              direction: 'in',
              date: email.date,
              snippet: email.text.slice(0, 300),
            },
          ],
          initialStage: !scored.relevant && spamStage ? spamStage : 'New',
          createdDetail: `Scanned from inbox (${email.from.address})`,
        })
        if (created) result.imported++
        else result.updated++
      } catch (err) {
        result.errors.push(`"${email.subject}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Advance the scan cursor (merge — keep email/host in meta).
    const cursorRow = await prisma.credential.findUnique({ where: { id: credentials.credentialId } })
    if (cursorRow) {
      await prisma.credential.update({
        where: { id: cursorRow.id },
        data: { meta: { ...(cursorRow.meta as object), lastScanAt: startedAt.toISOString() } },
      })
    }

    state.lastResult = result
    return result
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    state.running = false
  }
}
