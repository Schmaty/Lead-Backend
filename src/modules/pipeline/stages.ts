import type { WorkspaceSettings } from '../../types/settings.js'

/**
 * Pipeline categorization: figure out WHERE a lead sits in the pipeline rather
 * than always dropping it in the first stage. Two sources feed this:
 *   - the AI scorer's `pipelineStage` guess (email conversations), and
 *   - a Zoho CRM `Lead_Status` (CRM imports — authoritative, deterministic).
 * Both are funnelled through a workspace's own configured stage list, so a
 * renamed pipeline still resolves correctly.
 */

/** Semantic pipeline slots, earliest → latest. Independent of stage naming. */
export type StageSlot = 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost' | 'notfit'

/**
 * Resolve a semantic slot to the real stage in THIS workspace's list, or null
 * when the workspace has no stage for it. Keyword-matched so renamed stages
 * ("Reached out" for contacted, etc.) still land — closed slots defer to the
 * workspace's declared won/lost stages first.
 */
export function resolveSlot(slot: StageSlot, settings: WorkspaceSettings): string | null {
  const find = (re: RegExp): string | undefined => settings.stages.find((s) => re.test(s))
  switch (slot) {
    case 'new':
      return settings.stages[0] ?? null
    case 'contacted':
      return find(/contact|reached|nurtur|engag/i) ?? null
    case 'qualified':
      return find(/qualif|discovery|scoping/i) ?? null
    case 'proposal':
      return find(/proposal|quote|negotiat/i) ?? null
    case 'won':
      return settings.stages.includes(settings.wonStage) ? settings.wonStage : (find(/won/i) ?? null)
    case 'lost':
      return settings.stages.includes(settings.lostStage) ? settings.lostStage : (find(/lost/i) ?? null)
    case 'notfit':
      return find(/not\s*fit|unqualif|disqualif|junk/i) ?? (settings.stages.includes(settings.lostStage) ? settings.lostStage : null)
  }
}

/** A free-text label → slot, by keyword. Order matters: negatives ("not
 *  qualified") must beat their positive substring ("qualified"). */
function guessSlot(label: string): StageSlot | null {
  const s = label.toLowerCase()
  if (/junk|spam/.test(s)) return 'notfit'
  if (/not\s*qualif|un\s*qualif|dis\s*qualif|not\s*a?\s*fit/.test(s)) return 'notfit'
  if (/lost|dead|dropped|rejected|declined/.test(s)) return 'lost'
  if (/won|signed|closed[-\s]*won|booked|converted/.test(s)) return 'won'
  if (/proposal|quote|negotiat|contract/.test(s)) return 'proposal'
  if (/pre[-\s]?qualif|qualif|discovery|scoping/.test(s)) return 'qualified'
  if (/not\s*contacted|not\s*started|^\s*new\b|^\s*open\b|inbound|untouched/.test(s)) return 'new'
  if (/attempt|contact|follow|nurtur|working|in\s*progress|engag|replied/.test(s)) return 'contacted'
  return null
}

/**
 * Clamp a free-text stage label (from the AI scorer) onto the workspace's
 * configured stages. Exact match wins, then case-insensitive, then a keyword
 * slot guess; falls back to the first stage. Never returns a stage outside
 * `settings.stages`.
 */
export function normalizeStage(candidate: string | null | undefined, settings: WorkspaceSettings): string {
  const first = settings.stages[0] ?? 'New'
  const trimmed = (candidate ?? '').trim()
  if (!trimmed) return first
  if (settings.stages.includes(trimmed)) return trimmed
  const ci = settings.stages.find((s) => s.toLowerCase() === trimmed.toLowerCase())
  if (ci) return ci
  const slot = guessSlot(trimmed)
  if (slot) {
    const resolved = resolveSlot(slot, settings)
    if (resolved) return resolved
  }
  return first
}

/** Zoho standard + common custom Lead_Status values → semantic slot. Order
 *  matters (negatives before positives; "not contacted" before "contacted"). */
const ZOHO_STATUS_SLOTS: Array<{ match: RegExp; slot: StageSlot }> = [
  { match: /junk|spam/i, slot: 'notfit' },
  { match: /not\s*qualif|un\s*qualif|dis\s*qualif|not\s*a?\s*fit/i, slot: 'notfit' },
  { match: /lost|dead|dropped|rejected|declined/i, slot: 'lost' },
  { match: /won|signed|closed[-\s]*won|converted/i, slot: 'won' },
  { match: /proposal|quote|negotiat|contract/i, slot: 'proposal' },
  { match: /pre[-\s]?qualif|qualif/i, slot: 'qualified' },
  { match: /not\s*contacted|not\s*started|^new$|^open$/i, slot: 'new' },
  { match: /attempt|contacted|contact\s*in\s*future|follow|nurtur|working|in\s*progress/i, slot: 'contacted' },
]

/**
 * Map a Zoho CRM `Lead_Status` to the workspace pipeline stage that reflects
 * how far the deal has actually progressed. Returns null for a blank/unknown
 * status so the caller can fall back to the AI's assessment. The CRM is the
 * source of truth for where an imported lead sits, so this is authoritative
 * whenever it matches.
 */
export function mapCrmStatusToStage(status: string | null | undefined, settings: WorkspaceSettings): string | null {
  const s = (status ?? '').trim()
  if (!s) return null
  for (const { match, slot } of ZOHO_STATUS_SLOTS) {
    if (match.test(s)) return resolveSlot(slot, settings)
  }
  return null
}
