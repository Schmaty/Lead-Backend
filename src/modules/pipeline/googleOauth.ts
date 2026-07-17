/**
 * Google OAuth for client mailbox connections. The platform's OAuth app
 * (developer-managed GOOGLE_OAUTH_CLIENT credential) is what clients sign in
 * through; each workspace stores only its own refresh token (GMAIL_OAUTH
 * credential), which the scanner trades for short-lived IMAP access tokens.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
/** Full mail scope — required for IMAP XOAUTH2. openid+email identify the mailbox. */
const SCOPES = 'https://mail.google.com/ openid email'

export interface CodeExchangeResult {
  refreshToken: string | null
  accessToken: string
  /** The Google account email, from the id_token. */
  email: string | null
}

export interface GoogleOauthDeps {
  exchangeCode(params: {
    clientId: string
    clientSecret: string
    code: string
    redirectUri: string
  }): Promise<CodeExchangeResult>
  refreshAccessToken(params: { clientId: string; clientSecret: string; refreshToken: string }): Promise<string>
}

export function buildGoogleAuthUrl(params: { clientId: string; redirectUri: string; state: string }): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    // Always re-consent so Google returns a refresh token every time.
    prompt: 'consent',
    state: params.state,
  })
  return `${AUTH_ENDPOINT}?${query.toString()}`
}

export function googleRedirectUri(publicUrl: string): string {
  return `${publicUrl}/api/v1/auth/google/callback`
}

/** Decode the id_token payload. Safe here: it arrived over TLS directly from Google. */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      email?: string
    }
    return typeof payload.email === 'string' ? payload.email.toLowerCase() : null
  } catch {
    return null
  }
}

async function postToken(body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const detail = typeof json.error === 'string' ? json.error : `HTTP ${res.status}`
    throw new Error(`Google token endpoint rejected the request (${detail})`)
  }
  return json
}

let deps: GoogleOauthDeps = {
  async exchangeCode({ clientId, clientSecret, code, redirectUri }) {
    const json = await postToken({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    })
    return {
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      accessToken: String(json.access_token ?? ''),
      email: emailFromIdToken(typeof json.id_token === 'string' ? json.id_token : undefined),
    }
  },
  async refreshAccessToken({ clientId, clientSecret, refreshToken }) {
    const json = await postToken({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
    const accessToken = typeof json.access_token === 'string' ? json.access_token : ''
    if (!accessToken) throw new Error('Google returned no access token for the stored refresh token')
    return accessToken
  },
}

export const googleOauth = {
  exchangeCode: (params: Parameters<GoogleOauthDeps['exchangeCode']>[0]) => deps.exchangeCode(params),
  refreshAccessToken: (params: Parameters<GoogleOauthDeps['refreshAccessToken']>[0]) =>
    deps.refreshAccessToken(params),
}

/** Test hook: swap the Google network edges for fakes. Returns a restore fn. */
export function setGoogleOauthDepsForTesting(fake: GoogleOauthDeps): () => void {
  const previous = deps
  deps = fake
  return () => {
    deps = previous
  }
}
