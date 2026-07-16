import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
// The SDK's zod helper needs the zod v4 core, shipped by zod 3.25+ under /v4.
import { z } from 'zod/v4'
import type { WorkspaceSettings } from '../../types/settings.js'
import type { InboundEmail } from './mailbox.js'

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

function buildSystemPrompt(settings: WorkspaceSettings, workspaceName: string): string {
  return [
    `You score inbound email inquiries for "${workspaceName}", a small business that tracks its sales leads in a CRM.`,
    'Read the email and produce a structured lead assessment. Judge fit from the perspective of the business receiving the email.',
    `The inquiry categories are, verbatim: ${settings.inquiryTypes.map((t) => `"${t}"`).join(', ')}. Pick exactly one.`,
    'Scores are integers 0-10. Deal values are USD estimates for the full engagement; use 0/0 when the email gives no basis for a number.',
    'Anything you estimate without direct evidence in the email belongs in inferredFields.',
    'Mark relevant=false for anything that is not a genuine potential-client inquiry (newsletters, receipts, automated mail, spam, vendors selling TO the business). Still fill in the other fields as best you can.',
  ].join('\n')
}

function buildEmailBlock(email: InboundEmail): string {
  const body = email.text.length > 6000 ? `${email.text.slice(0, 6000)}\n…[truncated]` : email.text
  return [
    `From: ${email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}`,
    `Subject: ${email.subject}`,
    `Date: ${email.date.toISOString()}`,
    '',
    body,
  ].join('\n')
}

/**
 * Score one inbound email with Claude. Structured outputs guarantee the shape;
 * inquiryType is clamped to the workspace's configured list afterwards.
 */
export async function scoreEmail(
  client: Anthropic,
  email: InboundEmail,
  settings: WorkspaceSettings,
  workspaceName: string,
): Promise<ScoredLead> {
  const response = await client.messages.parse({
    model: SCORER_MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: buildSystemPrompt(settings, workspaceName),
    messages: [{ role: 'user', content: buildEmailBlock(email) }],
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
    fitScore: clamp(raw.fitScore),
    urgencyScore: clamp(raw.urgencyScore),
    leadScore: clamp(raw.leadScore),
    dealValueLow: Math.max(0, low),
    dealValueHigh: Math.max(0, high),
  }
}
