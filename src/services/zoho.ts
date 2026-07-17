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
        const record = normalizeRow(moduleName, row)
        records.set(`${record.module}:${record.id}`, record)
      }
    }
  }
  return [...records.values()]
}
