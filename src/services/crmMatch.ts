import type Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod/v4'
import { GATE_MODEL } from '../modules/pipeline/scorer.js'
import type { ZohoConfig } from './platformCredentials.js'
import { isSearchableWord, searchCrmByWord, type CrmRecord } from './zoho.js'

/**
 * AI-assisted CRM matching (cheapest model). When an exact email search finds
 * nothing, the model proposes a handful of search keywords (company, person
 * name, email-domain brand, distinctive tokens), we run Zoho keyword searches,
 * and the model then picks the single best-matching record — or none. Two cheap
 * Haiku calls, only spent when the free email lookup misses.
 */

export interface CrmMatchLead {
  name: string
  email: string
  org: string
  summary: string
  people: Array<{ name: string; email: string }>
}

const KEYWORD_MODEL = GATE_MODEL

const termsSchema = z.object({
  terms: z
    .array(z.string())
    .describe('2-5 short search keywords likely to find this lead in a CRM: the company name, the person\'s full name, the brand in their email domain, or other distinctive words. No emails, no punctuation.'),
})

const matchSchema = z.object({
  matchIndex: z.number().int().describe('Index of the CRM record that is the SAME person or company as the lead, or -1 if none of them are a real match.'),
  confidence: z.number().min(0).max(1).describe('How sure you are it is the same entity, 0-1.'),
  reason: z.string().describe('One short sentence on why it matches (or why none do).'),
})

function domainBrand(email: string): string | null {
  const domain = email.split('@')[1] ?? ''
  const host = domain.split('.')[0] ?? ''
  // Skip generic mailbox providers — their domain says nothing about the org.
  if (/^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|aol|proton|protonmail|me|msn)$/i.test(host)) return null
  return host.length >= 2 ? host : null
}

function leadBlock(lead: CrmMatchLead): string {
  const parts = [
    `Name: ${lead.name || '(unknown)'}`,
    lead.org ? `Company: ${lead.org}` : '',
    `Email: ${lead.email}`,
    ...lead.people.filter((p) => p.name || p.email).map((p) => `Contact: ${p.name} <${p.email}>`),
    lead.summary ? `About: ${lead.summary.slice(0, 400)}` : '',
  ]
  return parts.filter(Boolean).join('\n')
}

/**
 * Returns at most one AI-matched CRM record (tagged matchVia='ai' with a
 * confidence), or [] when nothing confidently matches. Never throws — a failure
 * anywhere just yields no match.
 */
export async function aiMatchCrm(anthropic: Anthropic, zoho: ZohoConfig, lead: CrmMatchLead): Promise<CrmRecord[]> {
  try {
    // 1) Ask the cheap model for keywords, seeded with deterministic signals.
    let terms: string[] = []
    try {
      const resp = await anthropic.messages.parse({
        model: KEYWORD_MODEL,
        max_tokens: 400,
        system:
          'You generate CRM search keywords. Given a sales lead, list the few words most likely to find their existing record in a CRM. Prefer the company name and the person\'s name. Return words only — no email addresses, no punctuation.',
        messages: [{ role: 'user', content: leadBlock(lead) }],
        output_config: { format: zodOutputFormat(termsSchema) },
      })
      terms = resp.parsed_output?.terms ?? []
    } catch {
      /* fall through to deterministic seeds */
    }
    const seeds = [lead.org, lead.name, domainBrand(lead.email) ?? '', ...lead.people.map((p) => p.name)]
    const searchable = [...new Set([...terms, ...seeds].map((t) => t.trim()).filter(isSearchableWord))].slice(0, 6)
    if (searchable.length === 0) return []

    // 2) Pull candidate records for those keywords.
    const candidates = (await searchCrmByWord(zoho, searchable, 10)).slice(0, 12)
    if (candidates.length === 0) return []

    // 3) Let the cheap model pick the one real match (or none).
    const list = candidates
      .map((c, i) => `[${i}] ${c.module === 'Leads' ? 'Lead' : 'Contact'}: ${c.name}${c.company ? ` — ${c.company}` : ''}${c.email ? ` <${c.email}>` : ''}`)
      .join('\n')
    const resp = await anthropic.messages.parse({
      model: KEYWORD_MODEL,
      max_tokens: 500,
      system:
        'You match a sales lead to an existing CRM record. Pick the record that is clearly the SAME person or company. Be strict: a shared industry or a similar name is NOT a match. If none is clearly the same entity, return matchIndex -1.',
      messages: [{ role: 'user', content: `LEAD:\n${leadBlock(lead)}\n\nCRM CANDIDATES:\n${list}` }],
      output_config: { format: zodOutputFormat(matchSchema) },
    })
    const pick = resp.parsed_output
    if (!pick || pick.matchIndex < 0 || pick.matchIndex >= candidates.length || pick.confidence < 0.6) return []
    const chosen = candidates[pick.matchIndex]!
    return [{ ...chosen, matchVia: 'ai', matchConfidence: Math.round(pick.confidence * 100) / 100 }]
  } catch {
    return []
  }
}
