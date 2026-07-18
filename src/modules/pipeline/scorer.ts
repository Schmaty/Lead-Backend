import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
// The SDK's zod helper needs the zod v4 core, shipped by zod 3.25+ under /v4.
import { z } from 'zod/v4'
import type { WorkspaceSettings } from '../../types/settings.js'
import type { InboundEmail } from './mailbox.js'
import { normalizeStage } from './stages.js'

/** Model used for scoring. Opus-tier: lead quality drives real follow-up work. */
export const SCORER_MODEL = 'claude-opus-4-8'

const score = z.number().int().min(0).max(10)

const scoredLeadSchema = z.object({
  relevant: z
    .boolean()
    .describe(
      'true only for a genuine inbound business inquiry from a potential client. false for newsletters, automated notifications, receipts, calendar invites, cold vendor pitches aimed AT the business, and spam.',
    ),
  name: z.string().describe("The sender's human name (best guess from the signature or address)"),
  org: z.string().describe("The sender's company or organization, or an empty string"),
  inquiryType: z.string().describe('Exactly one of the workspace inquiry categories, verbatim'),
  summary: z.string().describe('One or two sentences: who they are and what they want'),
  fitScore: score.describe('0-10: how well this inquiry fits the business'),
  urgencyScore: score.describe('0-10: how time-sensitive a reply is'),
  leadScore: score.describe('0-10: overall lead quality combining fit, urgency, and deal signals'),
  dealValueLow: z.number().min(0).describe('Low end of the estimated deal value in USD; 0 if unknowable'),
  dealValueHigh: z.number().min(0).describe('High end of the estimated deal value in USD; 0 if unknowable'),
  estPayoutRaw: z.string().describe('Human-readable payout estimate with reasoning, e.g. "$6,000–12,000 — 40-seat workshop, budget mentioned"'),
  estWork: z.string().describe('Rough delivery effort, e.g. "~2 workshop days + prep"'),
  recommendedNextStep: z.string().describe('The single next action the team should take'),
  pipelineStage: z
    .string()
    .describe(
      'The pipeline stage this deal has ACTUALLY reached, judged from the evidence — one of the workspace stages, verbatim. Start at the first stage for a fresh first-touch inquiry with no reply yet; advance only on concrete evidence (a reply exchanged, a call/meeting held, needs qualified, a proposal/quote sent, a deal explicitly won or lost). Never advance on optimism, and never pick a won stage unless the text confirms a signed/agreed deal.',
    ),
  draftReply: z.string().describe('A short, warm, specific reply draft the team could send. No placeholder brackets; sign off without a name.'),
  fitReasons: z.array(z.string()).describe('Short bullets for why this lead fits (empty if it does not)'),
  riskFlags: z.array(z.string()).describe('Short bullets for concerns or unknowns'),
  inferredFields: z
    .array(z.string())
    .describe('camelCase names of fields you guessed rather than read from the email, e.g. "dealValueLow"'),
})

export type ScoredLead = z.infer<typeof scoredLeadSchema>

export function createAnthropic(apiKey: string): Anthropic {
  return new Anthropic({ apiKey })
}

/** Prior state of an ongoing conversation, so re-scores assess the deal as it now stands. */
export interface ConversationContext {
  previousSummary: string
  /** Recent exchange, oldest first. Includes both sides ('in' = the lead, 'out' = the business). */
  exchange: Array<{ direction: 'in' | 'out'; date: Date; subject: string; snippet: string }>
  /** Meeting intel (from the transcript provider) tied to this lead, newest first. */
  meetings?: Array<{ title: string; date: Date; tldr: string }>
}

function buildSystemPrompt(settings: WorkspaceSettings, workspaceName: string): string {
  return [
    `You score inbound email inquiries for "${workspaceName}", a small business that tracks its sales leads in a CRM.`,
    'Read the email and produce a structured lead assessment. Judge fit from the perspective of the business receiving the email.',
    `The inquiry categories are, verbatim: ${settings.inquiryTypes.map((t) => `"${t}"`).join(', ')}. Pick exactly one.`,
    `The pipeline stages, earliest → latest, are: ${settings.stages.map((s) => `"${s}"`).join(', ')}. For pipelineStage, pick the one that matches how far this deal has actually progressed, using the evidence in front of you — default to the first stage unless there is clear evidence of progress.`,
    'Scores are integers 0-10. Deal values are USD estimates for the full engagement; use 0/0 when the email gives no basis for a number.',
    'Anything you estimate without direct evidence in the email belongs in inferredFields.',
    'Mark relevant=false for anything that is not a genuine potential-client inquiry (newsletters, receipts, automated mail, spam, vendors selling TO the business). Still fill in the other fields as best you can.',
    'When conversation history is provided, this is an ongoing exchange: assess the deal as it NOW stands (not just the latest email), update the summary to say where things stand, set recommendedNextStep to the next move in this conversation, write draftReply as the next reply in-thread, and set pipelineStage from how far the whole exchange has advanced (a back-and-forth is past the first stage).',
  ].join('\n')
}

const EXCHANGE_LIMIT = 8

function buildEmailBlock(email: InboundEmail, context?: ConversationContext): string {
  const body = email.text.length > 6000 ? `${email.text.slice(0, 6000)}\n…[truncated]` : email.text
  const parts: string[] = []
  if (context) {
    parts.push('=== CONVERSATION SO FAR ===')
    if (context.previousSummary) parts.push(`Previous assessment: ${context.previousSummary}`, '')
    for (const meeting of (context.meetings ?? []).slice(0, 3)) {
      const tldr = meeting.tldr.length > 700 ? `${meeting.tldr.slice(0, 700)}…` : meeting.tldr
      parts.push(`[MEETING · ${meeting.date.toISOString()}] ${meeting.title}`, tldr || '(no notes)', '')
    }
    for (const message of context.exchange.slice(-EXCHANGE_LIMIT)) {
      const who = message.direction === 'in' ? 'THEM' : 'US'
      const text = message.snippet.length > 800 ? `${message.snippet.slice(0, 800)}…` : message.snippet
      parts.push(`[${who} · ${message.date.toISOString()}] ${message.subject}`, text, '')
    }
    parts.push('=== LATEST EMAIL (assess the conversation as it now stands) ===')
  }
  parts.push(
    `From: ${email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}`,
    `Subject: ${email.subject}`,
    `Date: ${email.date.toISOString()}`,
    '',
    body,
  )
  return parts.join('\n')
}

/**
 * Score one inbound email with Claude — with the conversation so far when the
 * email continues a known thread. Structured outputs guarantee the shape;
 * inquiryType is clamped to the workspace's configured list afterwards.
 */
export async function scoreEmail(
  client: Anthropic,
  email: InboundEmail,
  settings: WorkspaceSettings,
  workspaceName: string,
  context?: ConversationContext,
  model: string = SCORER_MODEL,
): Promise<ScoredLead> {
  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: buildSystemPrompt(settings, workspaceName),
    messages: [{ role: 'user', content: buildEmailBlock(email, context) }],
    output_config: { format: zodOutputFormat(scoredLeadSchema) },
  })
  const parsed = response.parsed_output
  if (!parsed) {
    throw new Error(`Scoring returned no parseable output (stop_reason: ${response.stop_reason})`)
  }
  return normalizeScoredLead(parsed, settings)
}

/** Clamp model output onto workspace vocabulary (exported for tests). */
export function normalizeScoredLead(raw: ScoredLead, settings: WorkspaceSettings): ScoredLead {
  const inquiryType = settings.inquiryTypes.includes(raw.inquiryType)
    ? raw.inquiryType
    : (settings.inquiryTypes.find((t) => t.toLowerCase() === raw.inquiryType.toLowerCase()) ??
      settings.inquiryTypes.find((t) => /other/i.test(t)) ??
      settings.inquiryTypes[0] ??
      'Other')
  const clamp = (n: number): number => Math.max(0, Math.min(10, Math.round(n)))
  const [low, high] = raw.dealValueLow <= raw.dealValueHigh
    ? [raw.dealValueLow, raw.dealValueHigh]
    : [raw.dealValueHigh, raw.dealValueLow]
  return {
    ...raw,
    inquiryType,
    pipelineStage: normalizeStage(raw.pipelineStage, settings),
    fitScore: clamp(raw.fitScore),
    urgencyScore: clamp(raw.urgencyScore),
    leadScore: clamp(raw.leadScore),
    dealValueLow: Math.max(0, low),
    dealValueHigh: Math.max(0, high),
  }
}

/** Cheapest fast model — its only job is the relevance gate. */
export const GATE_MODEL = 'claude-haiku-4-5'

const relevanceSchema = z.object({
  decision: z.enum(['relevant', 'irrelevant', 'unsure']).describe('relevant = a possible business inquiry worth full scoring; irrelevant = clearly not; unsure = escalate'),
  confidence: z.number().min(0).max(1).describe('How certain you are, 0-1'),
  reason: z.string().describe('One short sentence'),
})

export type RelevanceVerdict = z.infer<typeof relevanceSchema>

/**
 * Cheap relevance gate, run before the expensive scorer on new conversations.
 * Irrelevant: newsletters, receipts, automated/calendar notifications,
 * delivery failures, vendor/SEO pitches selling TO the business, promotions,
 * generic spam, cold outreach with no buyer intent. Relevant: training /
 * consulting / workshop / speaking inquiries, partnership requests with
 * possible revenue, replies from prospects, orgs asking about AI programs,
 * and vague-but-real business inquiries. Uncertainty escalates — never drops.
 */
export async function classifyRelevance(
  client: Anthropic,
  email: InboundEmail,
  settings: WorkspaceSettings,
  workspaceName: string,
): Promise<RelevanceVerdict> {
  const response = await client.messages.parse({
    model: GATE_MODEL,
    max_tokens: 2000,
    system: [
      `You are a fast relevance filter for "${workspaceName}", a business that sells training/consulting services. Decide ONLY whether this inbound email could be a genuine business inquiry worth deeper analysis.`,
      'IRRELEVANT: newsletters, receipts, automated or calendar notifications, delivery failures, vendor/SEO pitches selling TO the business, promotions, generic spam, cold outreach with no real buyer intent, job applications.',
      `RELEVANT: inquiries about ${settings.inquiryTypes.join(', ')}; consulting/advisory/workshop/speaking requests; partnership requests with possible revenue; replies from current prospects; schools/companies asking about AI programs; vague but real business inquiries.`,
      'If in doubt, say "unsure" — uncertain emails are escalated, never discarded.',
    ].join('\n'),
    messages: [{ role: 'user', content: `From: ${email.from.name} <${email.from.address}>\nSubject: ${email.subject}\n\n${email.text.slice(0, 2500)}` }],
    output_config: { format: zodOutputFormat(relevanceSchema) },
  })
  const parsed = response.parsed_output
  if (!parsed) throw new Error(`Relevance gate returned no parseable output (stop_reason: ${response.stop_reason})`)
  return parsed
}
