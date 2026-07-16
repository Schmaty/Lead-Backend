import type {
  ApiKeyRow,
  Aggregates,
  CredentialRow,
  Lead,
  Role,
  SessionUser,
  Settings,
  UserInfo,
  WorkspaceInfo,
} from './types'

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? ''

let accessToken: string | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body != null ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(init.headers ?? {}),
    },
  })
}

/**
 * Silent session refresh; returns the new session or null. Concurrent callers
 * share one in-flight request — refresh tokens rotate on use, so two parallel
 * refreshes with the same cookie would look like token theft to the server.
 */
let refreshInFlight: Promise<{ accessToken: string; user: SessionUser } | null> | null = null

export function tryRefresh(): Promise<{ accessToken: string; user: SessionUser } | null> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BASE}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include' })
      if (!res.ok) return null
      const body = (await res.json()) as { accessToken: string; user: SessionUser }
      accessToken = body.accessToken
      return body
    } catch {
      return null
    } finally {
      setTimeout(() => {
        refreshInFlight = null
      }, 1000)
    }
  })()
  return refreshInFlight
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const res = await rawRequest(path, init)
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    const refreshed = await tryRefresh()
    if (refreshed) return request<T>(path, init, false)
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown }
    throw new ApiError(res.status, body.error ?? res.statusText, body.details)
  }
  return (await res.json()) as T
}

const post = (payload?: unknown): RequestInit => ({
  method: 'POST',
  body: payload === undefined ? undefined : JSON.stringify(payload),
})

const PAGE_SIZE = 200
const MAX_PAGES = 25

export const api = {
  // ── auth ────────────────────────────────────────────────────────────────
  async login(email: string, password: string): Promise<SessionUser> {
    const out = await request<{ accessToken: string; user: SessionUser }>('/auth/login', post({ email, password }))
    accessToken = out.accessToken
    return out.user
  },
  async signup(payload: { workspaceName: string; name: string; email: string; password: string }): Promise<SessionUser> {
    const out = await request<{ accessToken: string; user: SessionUser }>('/auth/signup', post(payload))
    accessToken = out.accessToken
    return out.user
  },
  async acceptInvite(token: string, name: string, password: string): Promise<SessionUser> {
    const out = await request<{ accessToken: string; user: SessionUser }>(
      '/auth/accept-invite',
      post({ token, name, password }),
    )
    accessToken = out.accessToken
    return out.user
  },
  logout: () =>
    request<{ ok: boolean }>('/auth/logout', { method: 'POST' }).finally(() => {
      accessToken = null
    }),
  me: () => request<{ user: SessionUser; workspace: { id: string; name: string; slug: string; settings: Settings } }>('/auth/me'),
  resetRequest: (email: string) => request<{ ok: boolean }>('/auth/password/reset-request', post({ email })),
  resetPassword: (token: string, newPassword: string) =>
    request<{ ok: boolean }>('/auth/password/reset', post({ token, newPassword })),
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const out = await request<{ ok: boolean; accessToken: string }>(
      '/auth/password/change',
      post({ currentPassword, newPassword }),
    )
    accessToken = out.accessToken
  },
  invite: (email: string, role: Role) =>
    request<{ inviteUrl: string; token: string; emailed: boolean }>('/auth/invite', post({ email, role })),

  // ── workspace ───────────────────────────────────────────────────────────
  workspace: () => request<WorkspaceInfo>('/workspace'),
  users: () => request<{ users: UserInfo[] }>('/workspace/users'),
  patchSettings: (patch: Record<string, unknown>) =>
    request<{ settings: Settings; recomputedLeads: number; renamedStages: number }>('/workspace/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  credentials: () => request<{ credentials: CredentialRow[] }>('/workspace/credentials'),
  putCredential: (kind: string, value: string) =>
    request<CredentialRow>(`/workspace/credentials/${kind}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  deleteCredential: (kind: string) => request<{ ok: boolean }>(`/workspace/credentials/${kind}`, { method: 'DELETE' }),
  apiKeys: () => request<{ apiKeys: ApiKeyRow[] }>('/workspace/api-keys'),
  createApiKey: (name: string) =>
    request<{ id: string; name: string; prefix: string; key: string }>('/workspace/api-keys', post({ name })),
  revokeApiKey: (id: string) => request<{ ok: boolean }>(`/workspace/api-keys/${id}`, { method: 'DELETE' }),

  // ── leads ───────────────────────────────────────────────────────────────
  /** Load the entire workspace lead set (threads + timeline included). */
  async listLeadsAll(): Promise<{ leads: Lead[]; aggregates: Aggregates }> {
    const leads: Lead[] = []
    let aggregates: Aggregates | null = null
    for (let page = 1; page <= MAX_PAGES; page++) {
      const out = await request<{ items: Lead[]; total: number; aggregates: Aggregates }>(
        `/leads?include=threads,timeline&pageSize=${PAGE_SIZE}&page=${page}&sort=receivedAt&order=desc`,
      )
      leads.push(...out.items)
      aggregates = out.aggregates
      if (out.items.length < PAGE_SIZE || leads.length >= out.total) break
    }
    return { leads, aggregates: aggregates! }
  },
  getLead: (id: string) => request<Lead>(`/leads/${id}`),
  createLead: (payload: Record<string, unknown>) => request<Lead>('/leads', post(payload)),
  patchLead: (id: string, patch: Record<string, unknown>) =>
    request<Lead>(`/leads/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteLead: (id: string) => request<{ ok: boolean }>(`/leads/${id}`, { method: 'DELETE' }),
}
