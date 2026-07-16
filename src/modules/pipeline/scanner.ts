import type { PrismaClient } from '@prisma/client'
import type { AppConfig } from '../../config.js'
import { decryptSecret } from '../../crypto/secrets.js'
import { AppError } from '../../middleware/errorHandler.js'
import { upsertLeadByExternalId } from '../../services/leadUpsert.js'
import { resolveSettings, type WorkspaceSettings } from '../../types/settings.js'
import { fetchRecentEmails, type InboundEmail, type MailboxConfig } from './mailbox.js'
import { createAnthropic, scoreEmail, type ScoredLead } from './scorer.js'

export const GMAIL_CREDENTIAL_KIND = 'GMAIL_IMAP'
export const ANTHROPIC_CREDENTIAL_KIND = 'ANTHROPIC_API_KEY'

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

interface ScanCredentials {
  mailbox: MailboxConfig
  anthropicApiKey: string
  gmailCredentialId: string
  lastScanAt: Date | null
}

/** Load and decrypt the scanner credentials, or null when not configured. */
export async function loadScanCredentials(
  prisma: PrismaClient,
  config: AppConfig,
  workspaceId: string,
): Promise<ScanCredentials | null> {
  const [gmail, anthropic] = await Promise.all([
    prisma.credential.findUnique({
      where: { workspaceId_kind: { workspaceId, kind: GMAIL_CREDENTIAL_KIND } },
    }),
    prisma.credential.findUnique({
      where: { workspaceId_kind: { workspaceId, kind: ANTHROPIC_CREDENTIAL_KIND } },
    }),
  ])
  if (!gmail || !anthropic) return null
  const meta = (gmail.meta ?? {}) as { email?: string; host?: string; port?: number; lastScanAt?: string }
  if (!meta.email) return null
  return {
    mailbox: {
      host: meta.host || DEFAULT_IMAP_HOST,
      port: meta.port || DEFAULT_IMAP_PORT,
      user: meta.email,
      pass: decryptSecret(gmail.encryptedValue, config.encryptionKey),
    },
    anthropicApiKey: decryptSecret(anthropic.encryptedValue, config.encryptionKey),
    gmailCredentialId: gmail.id,
    lastScanAt: meta.lastScanAt ? new Date(meta.lastScanAt) : null,
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

  const credentials = await loadScanCredentials(prisma, config, workspaceId)
  if (!credentials) {
    throw new AppError(
      400,
      'Inbox scanning is not configured — store the Gmail mailbox and Anthropic API key credentials first',
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

    const emails = await deps.fetchEmails(credentials.mailbox, since, MAX_EMAILS_PER_SCAN)

    const result: ScanResult = { at: startedAt.toISOString(), scanned: emails.length, imported: 0, updated: 0, skipped: 0, errors: [] }
    for (const email of emails) {
      // Never score the workspace's own outbound mail that lands in INBOX.
      if (email.from.address === credentials.mailbox.user.toLowerCase()) {
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
    const gmail = await prisma.credential.findUnique({ where: { id: credentials.gmailCredentialId } })
    if (gmail) {
      await prisma.credential.update({
        where: { id: gmail.id },
        data: { meta: { ...(gmail.meta as object), lastScanAt: startedAt.toISOString() } },
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
