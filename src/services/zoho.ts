import type { ZohoConfig } from './platformCredentials.js'

/**
 * Zoho CRM (read side). Verified against the live v8 API: token refresh via
 * accounts.zoho.com/oauth/v2/token, module search via
 * /crm/v8/{module}/search?email= (204 on miss), Zoho-oauthtoken auth header.
 *
 * Pushing leads INTO Zoho is deliberately gated behind CRM_PUSH_ENABLED:
 * current platform tokens carry read-only scopes; enabling push requires a
 * re-consented token with ZohoCRM.modules.*.WRITE.
 */
export const CRM_PUSH_ENABLED = false

export interface CrmRecord {
  module: 'Leads' | 'Contacts'
  id: string
  name: string
  company: string
  email: string
  phone: string
  /** Deep link into the Zoho CRM UI. */
  url: string
  /** How this record was matched to the lead: exact email, or AI keyword search. */
  matchVia?: 'email' | 'ai'
  /** 0..1 confidence when matched by AI keyword search. */
  matchConfidence?: number
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
}

export interface ZohoDeps {
  fetchJson(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; json: unknown }>
}

let deps: ZohoDeps = {
  async fetchJson(url, init) {
    const res = await fetch(url, init)
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json }
  },
}

/** Test hook: swap the Zoho network edge for a fake. Returns a restore fn. */
export function setZohoDepsForTesting(fake: ZohoDeps): () => void {
  const previous = deps
  deps = fake
  return () => {
    deps = previous
  }
}

/** Access tokens live ~1h; cache per client id with a safety margin. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

export function clearZohoTokenCacheForTesting(): void {
  tokenCache.clear()
}

async function getAccessToken(config: ZohoConfig): Promise<string> {
  const cached = tokenCache.get(config.clientId)
  if (cached && cached.expiresAt > Date.now()) return cached.token
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
  }).toString()
  const { status, json } = await deps.fetchJson(`${config.accountsUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const parsed = (json ?? {}) as TokenResponse
  if (status !== 200 || !parsed.access_token) {
    throw new Error(`Zoho token refresh failed (${parsed.error ?? `HTTP ${status}`})`)
  }
  const expiresAt = Date.now() + Math.max(60, (parsed.expires_in ?? 3600) - 120) * 1000
  tokenCache.set(config.clientId, { token: parsed.access_token, expiresAt })
  return parsed.access_token
}

interface ZohoRow {
  id?: string
  Email?: string | null
  Phone?: string | null
  Mobile?: string | null
  Last_Name?: string | null
  First_Name?: string | null
  Full_Name?: string | null
  Company?: string | null
  Account_Name?: { name?: string } | string | null
}

function normalizeRow(module: CrmRecord['module'], row: ZohoRow): CrmRecord {
  const name =
    row.Full_Name ||
    [row.First_Name, row.Last_Name].filter(Boolean).join(' ') ||
    row.Last_Name ||
    '(unnamed)'
  const company =
    typeof row.Account_Name === 'object' && row.Account_Name
      ? (row.Account_Name.name ?? '')
      : typeof row.Account_Name === 'string'
        ? row.Account_Name
        : (row.Company ?? '')
  return {
    module,
    id: row.id ?? '',
    name,
    company: company ?? '',
    email: row.Email ?? '',
    phone: row.Phone ?? row.Mobile ?? '',
    url: `https://crm.zoho.com/crm/tab/${module}/${row.id ?? ''}`,
  }
}

/**
 * Search Zoho Leads + Contacts for any of the given emails. Read-only; 204
 * from Zoho means no match. Results are deduped by module+id.
 */
export async function searchCrmByEmails(config: ZohoConfig, emails: string[]): Promise<CrmRecord[]> {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 10)
  if (unique.length === 0) return []
  const token = await getAccessToken(config)
  const records = new Map<string, CrmRecord>()
  for (const moduleName of ['Leads', 'Contacts'] as const) {
    for (const email of unique) {
      const { status, json } = await deps.fetchJson(
        `${config.apiDomain}/crm/v8/${moduleName}/search?email=${encodeURIComponent(email)}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      )
      if (status === 204 || json == null) continue
      if (status !== 200) throw new Error(`Zoho ${moduleName} search failed (HTTP ${status})`)
      const rows = ((json as { data?: ZohoRow[] }).data ?? []) as ZohoRow[]
      for (const row of rows) {
        const record = { ...normalizeRow(moduleName, row), matchVia: 'email' as const }
        records.set(`${record.module}:${record.id}`, record)
      }
    }
  }
  return [...records.values()]
}

export interface OpenCrmLead {
  record: CrmRecord
  description: string
  status: string
}

/**
 * The open (unconverted) records in Zoho's Leads module — the pool the
 * one-shot import turns into Leadline leads. Records without an email are
 * skipped (no reliable dedupe key).
 */
export async function listOpenLeads(config: ZohoConfig, limit = 50): Promise<OpenCrmLead[]> {
  const token = await getAccessToken(config)
  const fields = 'First_Name,Last_Name,Full_Name,Email,Company,Phone,Mobile,Description,Lead_Status'
  const { status, json } = await deps.fetchJson(
    `${config.apiDomain}/crm/v8/Leads?fields=${encodeURIComponent(fields)}&per_page=${Math.min(limit, 200)}&converted=false`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
  )
  if (status === 204 || json == null) return []
  if (status !== 200) throw new Error(`Zoho Leads list failed (HTTP ${status})`)
  const rows = ((json as { data?: Array<ZohoRow & { Description?: string | null; Lead_Status?: string | null }> }).data ?? [])
  return rows
    .filter((row) => row.Email)
    .slice(0, limit)
    .map((row) => ({
      record: normalizeRow('Leads', row),
      description: row.Description ?? '',
      status: row.Lead_Status ?? '',
    }))
}

/** Zoho rejects word searches under two chars or with special characters. */
export function isSearchableWord(term: string): boolean {
  const t = term.trim()
  return t.length >= 2 && !/[()[\]{}<>@,;:\\/"'*?=&%$#!]/.test(t)
}

/**
 * Global keyword search across Leads + Contacts (Zoho `word` search — matches
 * across name, company, email, etc.). Powers the AI keyword matcher: it feeds
 * candidate records the model ranks against the lead. Deduped by module+id.
 */
export async function searchCrmByWord(config: ZohoConfig, words: string[], limitPerWord = 10): Promise<CrmRecord[]> {
  const unique = [...new Set(words.map((w) => w.trim()).filter(isSearchableWord))].slice(0, 6)
  if (unique.length === 0) return []
  const token = await getAccessToken(config)
  const records = new Map<string, CrmRecord>()
  for (const moduleName of ['Leads', 'Contacts'] as const) {
    for (const word of unique) {
      const { status, json } = await deps.fetchJson(
        `${config.apiDomain}/crm/v8/${moduleName}/search?word=${encodeURIComponent(word)}&per_page=${Math.min(limitPerWord, 50)}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      )
      if (status === 204 || json == null) continue
      if (status !== 200) continue // a bad single word never sinks the whole match
      const rows = ((json as { data?: ZohoRow[] }).data ?? []) as ZohoRow[]
      for (const row of rows) {
        const record = normalizeRow(moduleName, row)
        records.set(`${record.module}:${record.id}`, record)
      }
    }
  }
  return [...records.values()]
}

/** The Zoho CRM UI page for creating a new Lead — used as the prefill fallback. */
export function crmCreateLeadUrl(): string {
  return 'https://crm.zoho.com/crm/tab/Leads/create'
}

export interface CrmCreateFields {
  firstName: string
  lastName: string
  email: string
  company: string
  phone: string
  title: string
  leadSource: string
  description: string
}

export type CrmCreateResult =
  | { ok: true; id: string; url: string }
  | { ok: false; scopeError: boolean; message: string }

/**
 * Create a Lead in Zoho from a Leadline lead. Needs a WRITE-scoped token
 * (ZohoCRM.modules.leads.CREATE); with the default read-only token this returns
 * { ok: false, scopeError: true } so the caller can fall back to the prefilled
 * form. Last_Name is Zoho's only hard-required Leads field.
 */
export async function createCrmLead(config: ZohoConfig, fields: CrmCreateFields): Promise<CrmCreateResult> {
  let token: string
  try {
    token = await getAccessToken(config)
  } catch (err) {
    return { ok: false, scopeError: false, message: err instanceof Error ? err.message : 'Zoho auth failed' }
  }
  const record: Record<string, string> = {
    Last_Name: fields.lastName || fields.firstName || fields.email || 'Unknown',
    Company: fields.company || 'Unknown',
    Lead_Source: fields.leadSource || 'Leadline',
  }
  if (fields.firstName) record.First_Name = fields.firstName
  if (fields.email) record.Email = fields.email
  if (fields.phone) record.Phone = fields.phone
  if (fields.title) record.Designation = fields.title
  if (fields.description) record.Description = fields.description

  const { status, json } = await deps.fetchJson(`${config.apiDomain}/crm/v8/Leads`, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ data: [record] }),
  })

  const top = json as { code?: string; message?: string; data?: Array<{ code?: string; message?: string; details?: { id?: string } }> } | null
  const scopeError =
    status === 401 ||
    status === 403 ||
    top?.code === 'OAUTH_SCOPE_MISMATCH' ||
    top?.code === 'INVALID_TOKEN' ||
    top?.data?.[0]?.code === 'OAUTH_SCOPE_MISMATCH'
  if (scopeError) {
    return { ok: false, scopeError: true, message: 'Your Zoho connection is read-only. Reconnect it with lead-create permission to push directly.' }
  }
  const row = top?.data?.[0]
  if (status >= 200 && status < 300 && row?.code === 'SUCCESS' && row.details?.id) {
    return { ok: true, id: row.details.id, url: `https://crm.zoho.com/crm/tab/Leads/${row.details.id}` }
  }
  return { ok: false, scopeError: false, message: row?.message || top?.message || `Zoho create failed (HTTP ${status})` }
}
