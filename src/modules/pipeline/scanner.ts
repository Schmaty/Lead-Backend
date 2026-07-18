import type { PrismaClient } from '@prisma/client'
import type { AppConfig } from '../../config.js'
import { decryptSecret } from '../../crypto/secrets.js'
import { AppError } from '../../middleware/errorHandler.js'
import {
  getInsight,
  listPastMeetings,
  type AmbientInsight,
  type AmbientMeeting,
} from '../../services/ambient.js'
import { syncLeadCrm } from '../../services/crmSync.js'
import { listOpenLeads } from '../../services/zoho.js'
import { upsertLeadByExternalId, type UpsertThread } from '../../services/leadUpsert.js'
import { upsertPerson } from '../../services/people.js'
import {
  getAmbientConfig,
  getGoogleOauthClient,
  getMicrosoftOauthClient,
  getPlatformAnthropicKey,
  getScorerModel,
  getZohoConfig,
  type AmbientConfig,
  type GoogleOauthClient,
  type MicrosoftOauthClient,
  type ZohoConfig,
} from '../../services/platformCredentials.js'
import { resolveSettings, type WorkspaceSettings } from '../../types/settings.js'
import { googleOauth } from './googleOauth.js'
import { microsoftOauth } from './microsoftOauth.js'
import {
  fetchRecentEmails,
  fetchSentEmails,
  type InboundEmail,
  type MailboxConfig,
} from './mailbox.js'
import { classifyRelevance, createAnthropic, scoreEmail, type ConversationContext, type RelevanceVerdict, type ScoredLead } from './scorer.js'
import { mapCrmStatusToStage } from './stages.js'

/** Client sign-in path (Google): value = Google refresh token, meta = { email, lastScanAt }. */
export const GMAIL_OAUTH_KIND = 'GMAIL_OAUTH'
/** Client sign-in path (Microsoft 365): value = MS refresh token, meta = { email, lastScanAt }. */
export const MICROSOFT_OAUTH_KIND = 'MICROSOFT_OAUTH'
/** Fallback path (developer-managed): value = app password, meta = { email, host?, port?, lastScanAt }. */
export const GMAIL_IMAP_KIND = 'GMAIL_IMAP'
/** Pre-platform installs stored the Anthropic key per workspace; still honored as a fallback. */
const LEGACY_ANTHROPIC_KIND = 'ANTHROPIC_API_KEY'

const DEFAULT_IMAP_HOST = 'imap.gmail.com'
/** Outlook / Microsoft 365 IMAP endpoint (OAuth XOAUTH2). */
const OUTLOOK_IMAP_HOST = 'outlook.office365.com'
const DEFAULT_IMAP_PORT = 993
/** Per-scan cap — the cheap gate makes wide coverage affordable. When the cap
 * is hit, the cursor only advances to the newest processed email, so the rest
 * of the window is picked up next scan instead of being skipped forever. */
const MAX_EMAILS_PER_SCAN = 100
/** Gate skips only when it is confidently irrelevant; below this, escalate. */
const GATE_SKIP_CONFIDENCE = 0.75
/** Sent mail costs no AI calls — a wider window keeps reply tracking complete. */
const MAX_SENT_PER_SCAN = 50
/** First-ever scan looks back this far. */
const FIRST_SCAN_LOOKBACK_MS = 7 * 24 * 3600 * 1000
/** Subsequent scans re-read a little history; the idempotent upsert dedupes. */
const RESCAN_OVERLAP_MS = 60 * 60 * 1000
/** The one-shot Import reaches much further back and reads much more. */
const IMPORT_LOOKBACK_MS = 90 * 24 * 3600 * 1000
const IMPORT_MAX_EMAILS = 200
const IMPORT_MAX_CRM_LEADS = 50

export interface ScanResult {
  at: string
  /** Inbound emails read from the inbox. */
  scanned: number
  /** New leads (new conversations). */
  imported: number
  /** New emails merged into existing leads' conversations. */
  merged: number
  /** Conversations seen again with nothing new (overlap re-reads). */
  updated: number
  /** Own-address inbox mail ignored. */
  skipped: number
  /** Irrelevant conversations (newsletters/receipts/spam) — never become leads, remembered so they cost no future tokens. */
  ignored: number
  /** Outbound replies detected in sent mail and attached to leads. */
  replies: number
  /** Meetings (from the transcript provider) newly attached to leads. */
  meetings: number
  /** Leads that gained new CRM matches in the Zoho pull pass. */
  crm: number
  errors: string[]
}

/** Live progress while a scan runs — what the dashboard banner renders. */
export interface ScanProgress {
  /** 'connecting' during IMAP fetch; 'scoring' per conversation; 'replies' during the sent-mail pass; 'meetings' during transcript enrichment. */
  phase: 'connecting' | 'scoring' | 'replies' | 'meetings' | 'crm'
  /** Conversations to score (not raw emails). */
  total: number
  processed: number
  imported: number
  merged: number
  updated: number
  skipped: number
  ignored: number
  replies: number
  meetings: number
  crm: number
}

interface ScanState {
  running: boolean
  progress?: ScanProgress
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
  fetchSentEmails: (config: MailboxConfig, since: Date, limit: number) => Promise<InboundEmail[]>
  scoreEmail: (
    apiKey: string,
    email: InboundEmail,
    settings: WorkspaceSettings,
    workspaceName: string,
    context?: ConversationContext,
    model?: string,
  ) => Promise<ScoredLead>
  listMeetings: (config: AmbientConfig, since: Date) => Promise<AmbientMeeting[]>
  getMeetingInsight: (config: AmbientConfig, insightId: string) => Promise<AmbientInsight>
  /** Cheap relevance gate (Haiku) run before the expensive scorer on new conversations. */
  classifyEmail: (
    apiKey: string,
    email: InboundEmail,
    settings: WorkspaceSettings,
    workspaceName: string,
  ) => Promise<RelevanceVerdict>
}

let defaultDeps: ScanDeps = {
  fetchEmails: fetchRecentEmails,
  fetchSentEmails,
  scoreEmail: (apiKey, email, settings, workspaceName, context, model) =>
    scoreEmail(createAnthropic(apiKey), email, settings, workspaceName, context, model),
  listMeetings: (config, since) => listPastMeetings(config, since),
  getMeetingInsight: (config, insightId) => getInsight(config, insightId),
  classifyEmail: (apiKey, email, settings, workspaceName) =>
    classifyRelevance(createAnthropic(apiKey), email, settings, workspaceName),
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
  /** Which sign-in connected the mailbox (null for the app-password fallback or when unconnected). */
  provider: 'google' | 'microsoft' | null
  email: string | null
  /** True when the developer has stored the platform Google OAuth client. */
  googleSignInAvailable: boolean
  /** True when the developer has stored the platform Microsoft (Azure AD) OAuth client. */
  microsoftSignInAvailable: boolean
  /** True when a platform (or legacy workspace) Anthropic key exists. */
  aiReady: boolean
  lastScanAt: Date | null
}

interface ScanCredentials {
  method: 'oauth' | 'imap'
  /** For the oauth method: which provider issued the refresh token. */
  provider?: 'google' | 'microsoft'
  email: string
  host: string
  port: number
  anthropicApiKey: string
  /** Developer-picked Claude model for scoring. */
  scorerModel: string
  /** Meeting-transcript provider, when the developer connected one. */
  ambient: AmbientConfig | null
  /** Zoho CRM (read side), when the developer connected it. */
  zoho: ZohoConfig | null
  /** The workspace credential row that carries the lastScanAt cursor in meta. */
  credentialId: string
  lastScanAt: Date | null
  /** oauth method */
  refreshToken?: string
  googleClient?: GoogleOauthClient
  microsoftClient?: MicrosoftOauthClient
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
  const [oauthCred, msOauthCred, imapCred, legacyAnthropic, platformKey, googleClient, microsoftClient, scorerModel, ambient, zoho] =
    await Promise.all([
      prisma.credential.findUnique({ where: { workspaceId_kind: { workspaceId, kind: GMAIL_OAUTH_KIND } } }),
      prisma.credential.findUnique({ where: { workspaceId_kind: { workspaceId, kind: MICROSOFT_OAUTH_KIND } } }),
      prisma.credential.findUnique({ where: { workspaceId_kind: { workspaceId, kind: GMAIL_IMAP_KIND } } }),
      prisma.credential.findUnique({ where: { workspaceId_kind: { workspaceId, kind: LEGACY_ANTHROPIC_KIND } } }),
      getPlatformAnthropicKey(prisma, config),
      getGoogleOauthClient(prisma, config),
      getMicrosoftOauthClient(prisma, config),
      getScorerModel(prisma, config),
      getAmbientConfig(prisma, config),
      getZohoConfig(prisma, config),
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
  const msMeta = (msOauthCred?.meta ?? {}) as CredentialMeta
  const imapMeta = (imapCred?.meta ?? {}) as CredentialMeta

  const googleConnected = !!(oauthCred && oauthMeta.email && googleClient)
  const microsoftConnected = !!(msOauthCred && msMeta.email && microsoftClient)

  let credentials: ScanCredentials | null = null
  if (googleConnected && anthropicApiKey) {
    credentials = {
      method: 'oauth',
      provider: 'google',
      email: oauthMeta.email!,
      host: DEFAULT_IMAP_HOST,
      port: DEFAULT_IMAP_PORT,
      anthropicApiKey,
      scorerModel,
      ambient,
      zoho,
      credentialId: oauthCred!.id,
      lastScanAt: oauthMeta.lastScanAt ? new Date(oauthMeta.lastScanAt) : null,
      refreshToken: decryptSecret(oauthCred!.encryptedValue, config.encryptionKey),
      googleClient: googleClient!,
    }
  } else if (microsoftConnected && anthropicApiKey) {
    credentials = {
      method: 'oauth',
      provider: 'microsoft',
      email: msMeta.email!,
      host: OUTLOOK_IMAP_HOST,
      port: DEFAULT_IMAP_PORT,
      anthropicApiKey,
      scorerModel,
      ambient,
      zoho,
      credentialId: msOauthCred!.id,
      lastScanAt: msMeta.lastScanAt ? new Date(msMeta.lastScanAt) : null,
      refreshToken: decryptSecret(msOauthCred!.encryptedValue, config.encryptionKey),
      microsoftClient: microsoftClient!,
    }
  } else if (imapCred && imapMeta.email && anthropicApiKey) {
    credentials = {
      method: 'imap',
      email: imapMeta.email,
      host: imapMeta.host || DEFAULT_IMAP_HOST,
      port: imapMeta.port || DEFAULT_IMAP_PORT,
      anthropicApiKey,
      scorerModel,
      ambient,
      zoho,
      credentialId: imapCred.id,
      lastScanAt: imapMeta.lastScanAt ? new Date(imapMeta.lastScanAt) : null,
      pass: decryptSecret(imapCred.encryptedValue, config.encryptionKey),
    }
  }

  // What's connected (for the UI), independent of whether AI is ready yet.
  const connectedProvider: 'google' | 'microsoft' | null = googleConnected ? 'google' : microsoftConnected ? 'microsoft' : null
  const connectedMethod: 'oauth' | 'imap' | null = connectedProvider ? 'oauth' : imapCred && imapMeta.email ? 'imap' : null
  const connectedMeta = connectedProvider === 'google' ? oauthMeta : connectedProvider === 'microsoft' ? msMeta : connectedMethod === 'imap' ? imapMeta : null
  return {
    info: {
      configured: credentials !== null,
      method: connectedMethod,
      provider: connectedProvider,
      email: connectedMeta?.email ?? null,
      googleSignInAvailable: googleClient !== null,
      microsoftSignInAvailable: microsoftClient !== null,
      aiReady: anthropicApiKey !== null,
      lastScanAt: connectedMeta?.lastScanAt ? new Date(connectedMeta.lastScanAt) : null,
    },
    credentials,
  }
}

/** The message permalink — also each thread entry's identity for merge dedup. */
const messageUrl = (messageId: string): string =>
  `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(messageId)}`

const normalizeSubject = (subject: string): string =>
  subject.replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').trim().toLowerCase()

const isReplySubject = (subject: string): boolean => /^\s*(re|fwd?|fw)\s*:/i.test(subject)

const asThread = (email: InboundEmail, direction: 'in' | 'out'): UpsertThread => ({
  subject: email.subject,
  url: messageUrl(email.messageId),
  direction,
  date: email.date,
  snippet: email.text.slice(0, 300),
})

/**
 * The conversation a message belongs to: the thread root from References /
 * In-Reply-To when present; otherwise, for "Re:"-style replies from a known
 * sender, the existing lead whose thread carries the same subject; otherwise
 * the message stands alone (its own Message-ID starts a new conversation).
 */
async function resolveThreadKey(
  prisma: PrismaClient,
  workspaceId: string,
  email: InboundEmail,
): Promise<string> {
  const root = email.references[0] ?? email.inReplyTo
  // 1. The message continues a thread we already track → stay in it.
  if (root) {
    const byRoot = await prisma.lead.findUnique({
      where: { workspaceId_externalId: { workspaceId, externalId: root } },
      select: { externalId: true },
    })
    if (byRoot?.externalId) return byRoot.externalId
  }
  // 2. The sender already has a lead (email-scanned OR CRM-imported) → fold this
  //    message into it, so new mail updates that lead's stage / summary / score.
  const known = await prisma.lead.findFirst({
    where: {
      workspaceId,
      deletedAt: null,
      externalId: { not: null },
      OR: [{ email: email.from.address }, { people: { some: { email: email.from.address } } }],
    },
    orderBy: { lastTouchedAt: 'desc' },
    select: { externalId: true },
  })
  if (known?.externalId) return known.externalId
  // 3. A new thread from an unknown sender keeps its thread root as identity.
  if (root) return root
  // 4. A "Re:"-style reply with no References — match by subject to a known lead.
  if (isReplySubject(email.subject)) {
    const candidates = await prisma.lead.findMany({
      where: { workspaceId, deletedAt: null, email: email.from.address, externalId: { not: null } },
      include: { threads: { select: { subject: true } } },
      take: 20,
      orderBy: { lastTouchedAt: 'desc' },
    })
    const wanted = normalizeSubject(email.subject)
    const match = candidates.find((lead) =>
      lead.threads.some((thread) => normalizeSubject(thread.subject) === wanted),
    )
    if (match?.externalId) return match.externalId
  }
  // 5. Stands alone — its own Message-ID starts a new conversation.
  return email.messageId
}

/**
 * Scan the workspace inbox: fetch new mail over IMAP, group it into
 * conversations, score each conversation with Claude (with prior context for
 * known threads), and upsert leads — new threads become leads, replies merge
 * into the lead they belong to. A second pass over sent mail attaches the
 * team's own replies, marks replySent, and advances brand-new leads to the
 * contacted stage. Human edits and manual winProbability overrides survive.
 */
export interface ScanOptions {
  /**
   * Deep import: 90-day email lookback, higher caps, and Zoho's open leads
   * pulled in as Leadline leads (auto-categorized by the scorer).
   */
  deep?: boolean
  /** Test hook: shrink the per-scan email cap. */
  emailCap?: number
}

export async function runScan(
  prisma: PrismaClient,
  config: AppConfig,
  workspaceId: string,
  deps: ScanDeps = defaultDeps,
  options: ScanOptions = {},
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
  const progress: ScanProgress = { phase: 'connecting', total: 0, processed: 0, imported: 0, merged: 0, updated: 0, skipped: 0, ignored: 0, replies: 0, meetings: 0, crm: 0 }
  state.progress = progress
  const startedAt = new Date()
  try {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    const settings = resolveSettings(workspace.settings)
    const since = options.deep
      ? new Date(startedAt.getTime() - IMPORT_LOOKBACK_MS)
      : credentials.lastScanAt
        ? new Date(credentials.lastScanAt.getTime() - RESCAN_OVERLAP_MS)
        : new Date(startedAt.getTime() - FIRST_SCAN_LOOKBACK_MS)
    const emailCap = options.emailCap ?? (options.deep ? IMPORT_MAX_EMAILS : MAX_EMAILS_PER_SCAN)

    const mailbox: MailboxConfig = { host: credentials.host, port: credentials.port, user: credentials.email }
    if (credentials.method === 'oauth') {
      mailbox.accessToken =
        credentials.provider === 'microsoft'
          ? await microsoftOauth.refreshAccessToken({
              clientId: credentials.microsoftClient!.clientId,
              clientSecret: credentials.microsoftClient!.clientSecret,
              tenant: credentials.microsoftClient!.tenant,
              refreshToken: credentials.refreshToken!,
            })
          : await googleOauth.refreshAccessToken({
              clientId: credentials.googleClient!.clientId,
              clientSecret: credentials.googleClient!.clientSecret,
              refreshToken: credentials.refreshToken!,
            })
    } else {
      mailbox.pass = credentials.pass
    }

    const emails = await deps.fetchEmails(mailbox, since, emailCap)
    const result: ScanResult = { at: startedAt.toISOString(), scanned: emails.length, imported: 0, merged: 0, updated: 0, skipped: 0, ignored: 0, replies: 0, meetings: 0, crm: 0, errors: [] }
    const ownAddress = credentials.email.toLowerCase()

    /** Audit invariant: every scanned message gets a fate on record. Never throws. */
    const logMessage = async (
      email: InboundEmail,
      threadRootId: string,
      status: string,
      extra: { decision?: string; confidence?: number; reason?: string; lastError?: string } = {},
    ): Promise<void> => {
      try {
        const fields = {
          threadRootId,
          subject: email.subject.slice(0, 200),
          fromEmail: email.from.address,
          receivedAt: email.date,
          status,
          decision: extra.decision ?? '',
          confidence: extra.confidence ?? null,
          reason: (extra.reason ?? '').slice(0, 300),
          lastError: (extra.lastError ?? '').slice(0, 300),
        }
        await prisma.scannedMessage.upsert({
          where: { workspaceId_messageId: { workspaceId, messageId: email.messageId } },
          create: { workspaceId, messageId: email.messageId, ...fields },
          update: fields,
        })
      } catch {
        /* the audit log must never break the scan */
      }
    }

    // ── Group inbound mail into conversations ────────────────────────────────
    const groups = new Map<string, InboundEmail[]>()
    for (const email of emails) {
      // Never score the workspace's own outbound mail that lands in INBOX.
      if (email.from.address === ownAddress) {
        result.skipped++
        progress.skipped++
        await logMessage(email, email.messageId, 'skipped_own_sent')
        continue
      }
      const key = await resolveThreadKey(prisma, workspaceId, email)
      const group = groups.get(key)
      if (group) group.push(email)
      else groups.set(key, [email])
    }
    for (const group of groups.values()) group.sort((a, b) => a.date.getTime() - b.date.getTime())

    progress.phase = 'scoring'
    progress.total = groups.size
    const touchedLeadIds = new Set<string>()

    // ── Score each conversation and upsert its lead ──────────────────────────
    for (const [threadKey, group] of groups) {
      try {
        const existing = await prisma.lead.findUnique({
          where: { workspaceId_externalId: { workspaceId, externalId: threadKey } },
          include: {
            threads: { orderBy: { date: 'asc' } },
            meetings: { orderBy: { startsAt: 'desc' }, take: 3 },
          },
        })

        // Previously judged irrelevant → skip without spending an AI call.
        if (!existing) {
          const remembered = await prisma.ignoredThread.findUnique({
            where: { workspaceId_threadKey: { workspaceId, threadKey } },
          })
          if (remembered) {
            result.ignored++
            progress.ignored++
            for (const email of group) await logMessage(email, threadKey, 'skipped_irrelevant', { reason: 'previously ignored' })
            continue
          }
        }

        // Overlap re-read with nothing new → no AI call, nothing to change.
        const knownUrls = new Set(existing?.threads.map((t) => t.url) ?? [])
        if (existing && group.every((email) => knownUrls.has(messageUrl(email.messageId)))) {
          result.updated++
          progress.updated++
          progress.processed++
          for (const email of group) await logMessage(email, threadKey, 'skipped_duplicate')
          continue
        }

        const newest = group[group.length - 1]!

        // Cheap relevance gate — only for brand-new conversations. Replies to
        // known leads always get full scoring; uncertainty escalates.
        if (!existing) {
          try {
            const verdict = await deps.classifyEmail(credentials.anthropicApiKey, newest, settings, workspace.name)
            if (verdict.decision === 'irrelevant' && verdict.confidence >= GATE_SKIP_CONFIDENCE) {
              try {
                await prisma.ignoredThread.create({
                  data: { workspaceId, threadKey, subject: newest.subject.slice(0, 200), fromAddress: newest.from.address },
                })
              } catch { /* concurrent scan already recorded it */ }
              result.ignored++
              progress.ignored++
              for (const email of group) {
                await logMessage(email, threadKey, 'skipped_irrelevant', {
                  decision: verdict.decision, confidence: verdict.confidence, reason: verdict.reason,
                })
              }
              continue
            }
          } catch (err) {
            // Gate failure = escalate to the full scorer, never drop.
            await logMessage(newest, threadKey, 'failed_relevance', {
              lastError: err instanceof Error ? err.message : String(err),
            })
          }
        }

        const earlier = group.slice(0, -1)
        const context: ConversationContext | undefined =
          existing || earlier.length > 0
            ? {
                previousSummary: existing?.summary ?? '',
                exchange: [
                  ...(existing?.threads ?? []).map((thread) => ({
                    direction: thread.direction as 'in' | 'out',
                    date: thread.date,
                    subject: thread.subject,
                    snippet: thread.snippet,
                  })),
                  ...earlier.map((email) => ({
                    direction: 'in' as const,
                    date: email.date,
                    subject: email.subject,
                    snippet: email.text.slice(0, 800),
                  })),
                ],
                meetings: (existing?.meetings ?? []).map((meeting) => ({
                  title: meeting.title,
                  date: meeting.startsAt,
                  tldr: meeting.tldr,
                })),
              }
            : undefined

        const scored = await deps.scoreEmail(
          credentials.anthropicApiKey,
          newest,
          settings,
          workspace.name,
          context,
          credentials.scorerModel,
        )

        // Not a real inquiry → never enters the system. The IgnoredThread row
        // is the log, and it makes every future scan skip this conversation
        // for free. (An existing lead whose reply scores irrelevant still
        // merges — active conversations are never silently dropped.)
        if (!scored.relevant && !existing) {
          try {
            await prisma.ignoredThread.create({
              data: { workspaceId, threadKey, subject: newest.subject.slice(0, 200), fromAddress: newest.from.address },
            })
          } catch {
            /* concurrent scan already recorded it */
          }
          result.ignored++
          progress.ignored++
          for (const email of group) {
            await logMessage(email, threadKey, 'skipped_irrelevant', { decision: 'irrelevant', reason: 'full scorer judged not a real inquiry' })
          }
          continue
        }

        const first = group[0]!
        const { lead, created, addedThreads } = await upsertLeadByExternalId(
          prisma,
          workspaceId,
          settings,
          {
            externalId: threadKey,
            receivedAt: existing ? existing.receivedAt : first.date,
            name: scored.name || newest.from.name || newest.from.address,
            email: newest.from.address || 'unknown@unknown.invalid',
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
            threads: group.map((email) => asThread(email, 'in')),
            // Land the lead where the conversation actually is; on merge this
            // repositions it (unless a human pinned the stage).
            initialStage: scored.pipelineStage,
            activityDate: scored.activityDate ? new Date(scored.activityDate) : null,
            createdDetail:
              scored.pipelineStage === settings.stages[0]
                ? `Scanned from inbox (${newest.from.address})`
                : `Scanned from inbox (${newest.from.address}) · detected stage: ${scored.pipelineStage}`,
          },
          { threadMode: 'merge' },
        )
        touchedLeadIds.add(lead.id)
        if (created) {
          result.imported++
          progress.imported++
        } else if (addedThreads > 0) {
          result.merged++
          progress.merged++
        } else {
          result.updated++
          progress.updated++
        }
        for (const email of group) {
          await logMessage(email, threadKey, created ? 'processed_lead' : addedThreads > 0 ? 'merged_existing_lead' : 'skipped_duplicate')
        }

        // Keep the person profile: the sender belongs to this lead, and their
        // messages hang off their profile via Thread.personId. On a merge the
        // sender may be a NEW correspondent — their display name wins over the
        // AI's lead-level name (which describes the primary contact).
        const personId = await upsertPerson(prisma, lead.id, {
          name: created ? scored.name || newest.from.name : newest.from.name || scored.name,
          email: newest.from.address,
          role: created ? 'Reached out' : undefined,
          seenAt: newest.date,
        })
        await prisma.thread.updateMany({
          where: { leadId: lead.id, personId: null, url: { in: group.map((email) => messageUrl(email.messageId)) } },
          data: { personId },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors.push(`"${group[0]!.subject}": ${message}`)
        // Not added to the ignore list, so the next scan's window retries it.
        for (const email of group) await logMessage(email, threadKey, 'failed_scoring', { lastError: message })
      } finally {
        progress.processed++
      }
    }

    // ── Track the team's own replies from sent mail ──────────────────────────
    progress.phase = 'replies'
    try {
      const sent = await deps.fetchSentEmails(mailbox, since, MAX_SENT_PER_SCAN)
      for (const email of sent) {
        try {
          const attached = await attachSentReply(prisma, workspaceId, settings, email)
          if (attached) {
            result.replies++
            progress.replies++
          }
        } catch (err) {
          result.errors.push(`sent "${email.subject}": ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } catch (err) {
      result.errors.push(`sent mailbox: ${err instanceof Error ? err.message : String(err)}`)
    }

    // ── Enrich leads with meeting intel from the transcript provider ─────────
    if (credentials.ambient) {
      progress.phase = 'meetings'
      try {
        const meetings = await deps.listMeetings(credentials.ambient, since)
        for (const meeting of meetings) {
          try {
            const attached = await attachMeeting(prisma, workspaceId, credentials.ambient, meeting, ownAddress, deps)
            result.meetings += attached
            progress.meetings += attached
          } catch (err) {
            result.errors.push(`meeting "${meeting.title}": ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      } catch (err) {
        result.errors.push(`meetings: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // ── Pull the CRM's view of leads (read-only; push stays coming-soon) ────
    if (credentials.zoho) {
      progress.phase = 'crm'

      // Deep import: every open Zoho lead becomes a Leadline lead,
      // auto-categorized by the scorer from the CRM record itself.
      if (options.deep) {
        try {
          const openLeads = await listOpenLeads(credentials.zoho, IMPORT_MAX_CRM_LEADS)
          for (const open of openLeads) {
            try {
              const email = open.record.email.toLowerCase()
              const known = await prisma.lead.findFirst({
                where: { workspaceId, deletedAt: null, OR: [{ email }, { people: { some: { email } } }] },
                select: { id: true },
              })
              if (known) continue
              const synthetic: InboundEmail = {
                messageId: `zoho:${open.record.id}`,
                from: { name: open.record.name, address: email },
                to: [credentials.email],
                subject: `CRM lead: ${open.record.name}${open.record.company ? ` — ${open.record.company}` : ''}`,
                date: startedAt,
                text: [
                  `Imported from Zoho CRM (status: ${open.status || 'unknown'}).`,
                  open.record.company ? `Company: ${open.record.company}` : '',
                  open.description,
                ].filter(Boolean).join('\n'),
                references: [],
                inReplyTo: null,
              }
              const scored = await deps.scoreEmail(
                credentials.anthropicApiKey, synthetic, settings, workspace.name, undefined, credentials.scorerModel,
              )
              // The CRM knows where the deal sits — its Lead_Status is
              // authoritative. Fall back to the AI's read only when the status
              // is blank or doesn't map to a known stage.
              const crmStage = mapCrmStatusToStage(open.status, settings)
              const initialStage = crmStage ?? scored.pipelineStage
              const { lead } = await upsertLeadByExternalId(prisma, workspaceId, settings, {
                externalId: synthetic.messageId,
                receivedAt: startedAt,
                name: scored.name || open.record.name,
                email,
                org: scored.org || open.record.company,
                source: 'CRM import',
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
                threads: [],
                initialStage,
                activityDate: scored.activityDate ? new Date(scored.activityDate) : null,
                createdDetail: `Imported from Zoho CRM (${open.record.name})${
                  open.status ? ` · status "${open.status}" → ${initialStage}` : ` · stage ${initialStage}`
                }`,
              }, { threadMode: 'merge' })
              touchedLeadIds.add(lead.id)
              await upsertPerson(prisma, lead.id, { name: open.record.name, email, role: 'Reached out', seenAt: startedAt })
              if (open.record.phone) {
                const person = await prisma.person.findFirst({ where: { leadId: lead.id, email } })
                if (person && !person.phone) await prisma.person.update({ where: { id: person.id }, data: { phone: open.record.phone } })
              }
              result.imported++
              progress.imported++
            } catch (err) {
              result.errors.push(`crm import "${open.record.name}": ${err instanceof Error ? err.message : String(err)}`)
            }
          }
        } catch (err) {
          result.errors.push(`crm import: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      try {
        const stale = await prisma.lead.findMany({
          where: { workspaceId, deletedAt: null, crmCheckedAt: null, id: { notIn: [...touchedLeadIds] } },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true },
        })
        // The cheap keyword matcher backs up the exact-email lookup.
        const crmAnthropic = createAnthropic(credentials.anthropicApiKey)
        for (const leadId of [...touchedLeadIds, ...stale.map((row) => row.id)]) {
          try {
            const { newMatches } = await syncLeadCrm(prisma, credentials.zoho, leadId, { anthropic: crmAnthropic })
            if (newMatches > 0) {
              result.crm++
              progress.crm++
            }
          } catch (err) {
            // One failure (bad token, rate limit) would repeat for every lead.
            result.errors.push(`crm: ${err instanceof Error ? err.message : String(err)}`)
            break
          }
        }
      } catch (err) {
        result.errors.push(`crm: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Advance the cursor only over what was actually covered: lastScanAt means
    // "everything up to here has been processed". If the fetch hit the cap,
    // the window wasn't fully read — advance only to the newest processed
    // email so the remainder is picked up next scan, never skipped.
    const fullyCovered = emails.length < emailCap
    const floor = credentials.lastScanAt ?? since // the cursor never moves backward
    const newestProcessed = emails.reduce((max, email) => (email.date > max ? email.date : max), floor)
    const coveredUntil = fullyCovered ? startedAt : newestProcessed
    const cursorRow = await prisma.credential.findUnique({ where: { id: credentials.credentialId } })
    if (cursorRow) {
      await prisma.credential.update({
        where: { id: cursorRow.id },
        data: { meta: { ...(cursorRow.meta as object), lastScanAt: coveredUntil.toISOString() } },
      })
    }

    state.lastResult = result
    return result
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    state.running = false
    state.progress = undefined
  }
}

/**
 * Attach one sent email to the lead whose conversation it answers: appends an
 * outbound thread entry, marks replySent, logs the reply on the timeline, and
 * advances a lead still in the first stage to the contacted stage. Returns
 * false when the email doesn't belong to any tracked conversation (or was
 * already recorded).
 */
async function attachSentReply(
  prisma: PrismaClient,
  workspaceId: string,
  settings: WorkspaceSettings,
  email: InboundEmail,
): Promise<boolean> {
  const root = email.references[0] ?? email.inReplyTo
  let lead =
    root != null
      ? await prisma.lead.findUnique({
          where: { workspaceId_externalId: { workspaceId, externalId: root } },
          include: { threads: { select: { url: true } } },
        })
      : null
  if (!lead && isReplySubject(email.subject) && email.to.length > 0) {
    const wanted = normalizeSubject(email.subject)
    const candidates = await prisma.lead.findMany({
      where: { workspaceId, deletedAt: null, email: { in: email.to } },
      include: { threads: { select: { url: true, subject: true } } },
      take: 20,
      orderBy: { lastTouchedAt: 'desc' },
    })
    lead =
      candidates.find((candidate) =>
        candidate.threads.some((thread) => normalizeSubject(thread.subject ?? '') === wanted),
      ) ?? null
  }
  if (!lead) return false

  const url = messageUrl(email.messageId)
  if (lead.threads.some((thread) => thread.url === url)) return false

  const firstStage = settings.stages[0]
  const contactedStage = settings.stages.find((s) => /contact/i.test(s))
  const advanceStage = lead.stage === firstStage && contactedStage && contactedStage !== lead.stage

  // The reply belongs to whichever of the lead's people it was sent to.
  const recipients = email.to
  const person = await prisma.person.findFirst({
    where: { leadId: lead.id, email: { in: recipients } },
  })

  await prisma.$transaction([
    prisma.thread.create({
      data: {
        leadId: lead.id,
        subject: email.subject,
        url,
        direction: 'out',
        date: email.date,
        snippet: email.text.slice(0, 300),
        personId: person?.id ?? null,
      },
    }),
    prisma.timelineEvent.create({
      data: { leadId: lead.id, type: 'reply_sent', actor: 'system', detail: `Reply sent: "${email.subject}"`, at: email.date },
    }),
    ...(advanceStage
      ? [
          prisma.timelineEvent.create({
            data: {
              leadId: lead.id,
              type: 'stage_change',
              actor: 'system',
              detail: `Moved to ${contactedStage} — reply sent`,
              at: email.date,
            },
          }),
        ]
      : []),
    prisma.lead.update({
      where: { id: lead.id },
      data: {
        replySent: true,
        ...(advanceStage ? { stage: contactedStage } : {}),
        ...(email.date > lead.lastTouchedAt ? { lastTouchedAt: email.date } : {}),
      },
    }),
  ])
  return true
}

/**
 * Attach one meeting from the transcript provider to every lead whose contact
 * (lead email or any person on the profile) attended: stores the meeting with
 * its AI dossier/tldr, adds each external attendee to the lead's people, and
 * logs a `meeting` timeline event. Idempotent by (leadId, meeting id).
 * Returns how many leads gained this meeting.
 */
async function attachMeeting(
  prisma: PrismaClient,
  workspaceId: string,
  ambient: AmbientConfig,
  meeting: AmbientMeeting,
  ownAddress: string,
  deps: ScanDeps,
): Promise<number> {
  const external = meeting.attendees.filter((a) => a.email && a.email !== ownAddress)
  if (external.length === 0) return 0
  const emails = external.map((a) => a.email)
  const leads = await prisma.lead.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      OR: [{ email: { in: emails } }, { people: { some: { email: { in: emails } } } }],
    },
    select: { id: true, lastTouchedAt: true },
  })
  if (leads.length === 0) return 0

  let insight: AmbientInsight | null = null
  let attached = 0
  for (const lead of leads) {
    const known = await prisma.meeting.findUnique({
      where: { leadId_externalId: { leadId: lead.id, externalId: meeting.id } },
    })
    if (known) continue
    if (!insight) {
      insight = meeting.insightId
        ? await deps.getMeetingInsight(ambient, meeting.insightId)
        : { tldr: '', text: '' }
    }
    await prisma.$transaction([
      prisma.meeting.create({
        data: {
          leadId: lead.id,
          externalId: meeting.id,
          title: meeting.title,
          startsAt: meeting.startsAt,
          endsAt: meeting.endsAt,
          attendees: external.map((a) => ({ name: a.name, email: a.email, organizer: a.organizer })),
          tldr: insight.tldr,
          dossier: insight.text,
          url: meeting.insightUrl,
        },
      }),
      prisma.timelineEvent.create({
        data: {
          leadId: lead.id,
          type: 'meeting',
          actor: 'system',
          detail: `Meeting: "${meeting.title}"`,
          at: meeting.startsAt,
        },
      }),
      ...(meeting.startsAt > lead.lastTouchedAt
        ? [prisma.lead.update({ where: { id: lead.id }, data: { lastTouchedAt: meeting.startsAt } })]
        : []),
    ])
    for (const attendee of external) {
      await upsertPerson(prisma, lead.id, {
        name: attendee.name,
        email: attendee.email,
        role: 'Meeting attendee',
        seenAt: meeting.startsAt,
      })
    }
    attached++
  }
  return attached
}
