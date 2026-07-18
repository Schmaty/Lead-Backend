/**
 * Microsoft 365 / Outlook OAuth for client mailbox connections — the Outlook
 * counterpart to googleOauth.ts. The platform's Azure AD app registration
 * (developer-managed MICROSOFT_OAUTH_CLIENT credential) is what clients sign in
 * through; each workspace stores only its own refresh token (MICROSOFT_OAUTH
 * credential), which the scanner trades for short-lived IMAP access tokens
 * (XOAUTH2 against outlook.office365.com — the same path Gmail uses).
 */

/** Microsoft identity platform v2 endpoints (tenant-scoped). */
function authEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`
}
function tokenEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`
}

/**
 * offline_access → a refresh token; the Outlook IMAP scope → XOAUTH2 access;
 * openid+email+profile identify the mailbox address. IMAP.AccessAsUser.All is
 * the delegated scope Outlook IMAP requires.
 */
const SCOPES = 'openid email profile offline_access https://outlook.office.com/IMAP.AccessAsUser.All'

export interface CodeExchangeResult {
  refreshToken: string | null
  accessToken: string
  /** The Microsoft account email, from the id_token. */
  email: string | null
}

export interface MicrosoftOauthDeps {
  exchangeCode(params: {
    clientId: string
    clientSecret: string
    tenant: string
    code: string
    redirectUri: string
  }): Promise<CodeExchangeResult>
  refreshAccessToken(params: { clientId: string; clientSecret: string; tenant: string; refreshToken: string }): Promise<string>
}

export function buildMicrosoftAuthUrl(params: { clientId: string; tenant: string; redirectUri: string; state: string }): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: SCOPES,
    // Let the user pick which account receives their inquiries.
    prompt: 'select_account',
    state: params.state,
  })
  return `${authEndpoint(params.tenant)}?${query.toString()}`
}

export function microsoftRedirectUri(publicUrl: string): string {
  return `${publicUrl}/api/v1/auth/microsoft/callback`
}

/** Decode the id_token payload. Safe here: it arrived over TLS directly from Microsoft. */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      email?: string
      preferred_username?: string
      upn?: string
    }
    const raw = payload.email || payload.preferred_username || payload.upn
    return typeof raw === 'string' && raw.includes('@') ? raw.toLowerCase() : null
  } catch {
    return null
  }
}

async function postToken(tenant: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(tokenEndpoint(tenant), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const detail =
      typeof json.error_description === 'string'
        ? json.error_description.split('\n')[0]
        : typeof json.error === 'string'
          ? json.error
          : `HTTP ${res.status}`
    throw new Error(`Microsoft token endpoint rejected the request (${detail})`)
  }
  return json
}

let deps: MicrosoftOauthDeps = {
  async exchangeCode({ clientId, clientSecret, tenant, code, redirectUri }) {
    const json = await postToken(tenant, {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: SCOPES,
    })
    return {
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      accessToken: String(json.access_token ?? ''),
      email: emailFromIdToken(typeof json.id_token === 'string' ? json.id_token : undefined),
    }
  },
  async refreshAccessToken({ clientId, clientSecret, tenant, refreshToken }) {
    const json = await postToken(tenant, {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPES,
    })
    const accessToken = typeof json.access_token === 'string' ? json.access_token : ''
    if (!accessToken) throw new Error('Microsoft returned no access token for the stored refresh token')
    return accessToken
  },
}

export const microsoftOauth = {
  exchangeCode: (params: Parameters<MicrosoftOauthDeps['exchangeCode']>[0]) => deps.exchangeCode(params),
  refreshAccessToken: (params: Parameters<MicrosoftOauthDeps['refreshAccessToken']>[0]) => deps.refreshAccessToken(params),
}

/** Test hook: swap the Microsoft network edges for fakes. Returns a restore fn. */
export function setMicrosoftOauthDepsForTesting(fake: MicrosoftOauthDeps): () => void {
  const previous = deps
  deps = fake
  return () => {
    deps = previous
  }
}
