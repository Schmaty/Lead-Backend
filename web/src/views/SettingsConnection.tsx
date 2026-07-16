import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { api, ApiError } from '../api'
import { fmtDate } from '../compute'
import { useDesk } from '../store'
import { btnSmall, C, card, inputS, linkDanger, mono } from '../styles'
import type { CredentialRow, ScanStatus } from '../types'

const A = '#12433B'
const sectionDesc: CSSProperties = { fontSize: 12, color: C.faint, marginBottom: 16, lineHeight: 1.5, maxWidth: '62ch' }
const sectionTitle: CSSProperties = { fontWeight: 600, fontSize: 15, marginBottom: 3 }
const credBox: CSSProperties = { border: `1px solid ${C.line}`, borderRadius: 10, padding: '13px 15px' }
const credInput: CSSProperties = { padding: '8px 10px', border: `1px solid ${C.border2}`, borderRadius: 7, fontSize: 12.5, fontFamily: mono, background: C.bg2 }
const devBadge: CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: '#fff', background: A, borderRadius: 5, padding: '3px 7px', textTransform: 'uppercase' }

function StoredValue({ cred, onRemove }: { cred: CredentialRow; onRemove: () => void }): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '0 0 auto' }}>
      <span style={{ fontFamily: mono, fontSize: 12, background: C.bg4, borderRadius: 6, padding: '4px 8px' }}>{cred.maskedValue}</span>
      <span style={{ fontSize: 11, color: C.faint }}>Rotated {fmtDate(cred.updatedAt)}</span>
      <button onClick={onRemove} style={linkDanger}>Remove</button>
    </div>
  )
}

export default function ConnectionTab(): ReactNode {
  const desk = useDesk()
  const { st, set } = desk
  const settings = st.settings!
  const isDev = !!st.user?.developer
  const [scan, setScan] = useState<ScanStatus | null>(null)
  const [platformCreds, setPlatformCreds] = useState<CredentialRow[]>([])
  const [anthropicKey, setAnthropicKey] = useState('')
  const [googleId, setGoogleId] = useState('')
  const [googleSecret, setGoogleSecret] = useState('')
  const [gmailEmail, setGmailEmail] = useState('')
  const [gmailPass, setGmailPass] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [newKeyName, setNewKeyName] = useState('')
  const pollRef = useRef<number | null>(null)

  const findCred = (kind: string): CredentialRow | undefined => st.credentials.find((c) => c.kind === kind)
  const findPlatform = (kind: string): CredentialRow | undefined => platformCreds.find((c) => c.kind === kind)
  const webhookCred = findCred('N8N_WEBHOOK')
  const anthropicCred = findPlatform('ANTHROPIC_API_KEY')
  const googleCred = findPlatform('GOOGLE_OAUTH_CLIENT')

  const loadStatus = async (): Promise<void> => {
    const status = await api.scanStatus().catch(() => null)
    if (status) {
      setScan(status)
      // A scheduled scan may already be in flight — attach and track it live.
      if (status.running && !pollRef.current) startPolling()
    }
  }
  const loadPlatform = async (): Promise<void> => {
    if (!isDev) return
    const out = await api.platformCredentials().catch(() => null)
    if (out) setPlatformCreds(out.credentials)
  }
  useEffect(() => {
    void loadStatus()
    void loadPlatform()
    // Returning from the Google consent screen: #/settings?gmail=connected|error
    const match = window.location.hash.match(/[?&]gmail=(\w+)/)
    if (match) {
      desk.toast(match[1] === 'connected' ? 'Gmail connected — inbox scanning is ready.' : 'Google sign-in didn’t complete — please try again.')
      window.history.replaceState(null, '', `${window.location.pathname}#/settings`)
    }
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startPolling = (): void => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    pollRef.current = window.setInterval(() => {
      void api.scanStatus().then((status) => {
        setScan(status)
        if (status.running) return
        if (pollRef.current) window.clearInterval(pollRef.current)
        pollRef.current = null
        if (status.lastError) desk.toast(`Scan failed: ${status.lastError}`)
        else if (status.lastResult) {
          const r = status.lastResult
          const parts = [`${r.imported} new`, `${r.merged} merged`, ...(r.replies ? [`${r.replies} replies tracked`] : [])]
          desk.toast(`Scan complete — ${parts.join(', ')}`)
        }
        void desk.refreshLeads()
      }).catch(() => undefined)
    }, 2000)
  }

  const scanNow = async (): Promise<void> => {
    try {
      await api.scan()
    } catch (e) {
      // 409 = a scheduled scan is already in flight — track it instead of bailing.
      if (!(e instanceof ApiError && e.status === 409)) {
        desk.toast(e instanceof Error ? e.message : 'Scan failed to start')
        return
      }
    }
    setScan((s) => (s ? { ...s, running: true } : s))
    startPolling()
  }

  const connectGmail = async (): Promise<void> => {
    try {
      const { url } = await api.gmailConnect()
      window.location.href = url
    } catch (e) {
      desk.toast(e instanceof Error ? e.message : 'Could not start Google sign-in')
    }
  }

  const disconnectMailbox = async (): Promise<void> => {
    const kind = scan?.method === 'oauth' ? 'GMAIL_OAUTH' : 'GMAIL_IMAP'
    await desk.removeCredential(kind)
    void loadStatus()
  }

  const savePlatform = async (kind: string, value: string, meta: Record<string, unknown> | undefined, clear: () => void): Promise<void> => {
    if (!value.trim()) { desk.toast('Paste a value first — secrets are write-only.'); return }
    try {
      await api.putPlatformCredential(kind, value.trim(), meta)
      desk.toast('Platform credential stored.')
      clear()
      void loadPlatform()
      void loadStatus()
    } catch (e) {
      desk.toast(e instanceof Error ? e.message : 'Failed to store credential')
    }
  }
  const removePlatform = async (kind: string): Promise<void> => {
    try {
      await api.deletePlatformCredential(kind)
      void loadPlatform()
      void loadStatus()
    } catch (e) {
      desk.toast(e instanceof Error ? e.message : 'Failed to remove credential')
    }
  }
  const saveWorkspaceSecret = async (kind: string, value: string, meta: Record<string, unknown> | undefined, clear: () => void): Promise<void> => {
    if (!value.trim()) { desk.toast('Paste a value first — secrets are write-only.'); return }
    await desk.saveCredential(kind, value.trim(), meta)
    clear()
    void loadStatus()
  }

  const activeKeys = st.apiKeys.filter((k) => !k.revokedAt)
  const lastResult = scan?.lastResult ?? null
  const mailboxConnected = !!scan?.email
  const configured = scan?.configured ?? false
  const callbackUrl = `${window.location.origin}/api/v1/auth/google/callback`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Client-facing: connect the inbox by signing in ─────────────────── */}
      <div style={card}>
        <div style={sectionTitle}>Inbox scanning</div>
        <div style={sectionDesc}>
          Leadline reads your inbox on a schedule, scores each new inquiry with AI, and files it here — everything lives in Leadline&apos;s own database. AI scoring is included; there are no keys for you to manage.
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, background: C.bg3, borderRadius: 10, padding: '13px 15px', marginBottom: 18 }}>
          <div style={{ width: 9, height: 9, borderRadius: 999, flex: '0 0 auto', marginTop: 5, background: scan?.running ? C.gold : configured ? C.ok : C.gold, animation: scan?.running ? 'll-pulse 1.2s ease infinite' : undefined }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {scan?.running ? 'Scanning now…' : configured ? 'Inbox scanning armed' : 'Not scanning yet'}
            </div>
            <div style={{ fontSize: 12, color: C.sub, marginTop: 2, lineHeight: 1.45 }}>
              {scan?.running
                ? scan.progress?.phase === 'replies'
                  ? `Checking sent mail for your replies…${scan.progress.replies ? ` ${scan.progress.replies} tracked` : ''}`
                  : scan.progress?.phase === 'scoring'
                    ? scan.progress.total === 0
                      ? 'Inbox read — no new mail in this window.'
                      : `Scoring conversation ${Math.min(scan.progress.processed + 1, scan.progress.total)} of ${scan.progress.total} — ${scan.progress.imported} new, ${scan.progress.merged} merged${scan.progress.skipped ? `, ${scan.progress.skipped} skipped` : ''} so far`
                    : 'Connecting to the inbox and reading new mail…'
                : configured
                  ? scan?.lastScanAt
                    ? `Last scan ${fmtDate(scan.lastScanAt)}${lastResult ? ` — ${lastResult.imported} new, ${lastResult.merged} merged into existing leads, ${lastResult.replies} replies tracked${lastResult.errors.length ? `, ${lastResult.errors.length} errors` : ''}` : ''}`
                    : 'Ready — the first scan reads the last 7 days of mail.'
                  : mailboxConnected && !scan?.aiReady
                    ? 'Mailbox connected. AI scoring isn’t enabled yet — your developer needs to finish platform setup.'
                    : 'Connect your Gmail inbox below to start.'}
            </div>
            {scan?.running && scan.progress && scan.progress.phase === 'scoring' && scan.progress.total > 0 && (
              <div style={{ height: 4, background: C.bg4, borderRadius: 999, marginTop: 8, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.round((scan.progress.processed / scan.progress.total) * 100)}%`, background: A, borderRadius: 999, transition: 'width .4s ease' }} />
              </div>
            )}
            {!scan?.running && scan?.lastError && <div style={{ fontSize: 12, color: C.danger, marginTop: 4 }}>Last scan failed: {scan.lastError}</div>}
          </div>
        </div>

        <div style={credBox}>
          {mailboxConnected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Gmail — {scan!.email}</div>
                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 1 }}>
                  {scan!.method === 'oauth' ? 'Connected with Google sign-in.' : 'Connected via app password (developer fallback).'}
                </div>
              </div>
              <button onClick={() => void disconnectMailbox()} style={linkDanger}>Disconnect</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Gmail inbox</div>
                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 1 }}>
                  {scan?.googleSignInAvailable
                    ? 'Sign in with the Google account that receives your inquiries. Leadline gets read access to that inbox — nothing else.'
                    : 'Google sign-in isn’t set up on this deployment yet — ask your developer to finish platform setup.'}
                </div>
              </div>
              <button
                onClick={() => void connectGmail()}
                disabled={!scan?.googleSignInAvailable}
                style={{ ...btnSmall, opacity: scan?.googleSignInAvailable ? 1 : 0.5, cursor: scan?.googleSignInAvailable ? 'pointer' : 'default' }}
              >
                Sign in with Google
              </button>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 18, flexWrap: 'wrap' }}>
          <button
            onClick={() => void scanNow()}
            disabled={!configured || !!scan?.running}
            style={{ ...btnSmall, opacity: !configured || scan?.running ? 0.5 : 1, cursor: !configured || scan?.running ? 'default' : 'pointer' }}
          >
            {scan?.running ? 'Scanning…' : 'Scan now'}
          </button>
          <div style={{ display: 'flex', border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'hidden', flexWrap: 'wrap' }}>
            {([[5, 'Every 5 min'], [15, 'Every 15 min'], [60, 'Hourly'], [240, 'Every 4 hours']] as const).map(([minutes, label]) => {
              const active = settings.scanSettings.pollMinutes === minutes
              return (
                <button key={minutes} onClick={() => void desk.saveSettings({ scanSettings: { pollMinutes: minutes } })} style={{ padding: '7px 13px', fontSize: 12.5, fontWeight: active ? 600 : 500, cursor: 'pointer', border: 'none', background: active ? 'rgba(18,67,59,.09)' : '#fff', color: active ? A : C.sub }}>
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Developer-only: the universal platform secrets ─────────────────── */}
      {isDev && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <div style={{ ...sectionTitle, marginBottom: 0 }}>Platform</div>
            <span style={devBadge}>Developer</span>
          </div>
          <div style={sectionDesc}>
            Universal secrets that power every workspace — visible only to the developer account. Clients never see these; they just sign in.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={credBox}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Anthropic API key (universal)</div>
                  <div style={{ fontSize: 11.5, color: C.faint, marginTop: 1 }}>One key scores every workspace&apos;s mail — the platform absorbs the AI bill.</div>
                </div>
                {anthropicCred && <StoredValue cred={anthropicCred} onRemove={() => void removePlatform('ANTHROPIC_API_KEY')} />}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} type="password" placeholder="sk-ant-…" style={{ ...credInput, flex: 1 }} />
                <button onClick={() => void savePlatform('ANTHROPIC_API_KEY', anthropicKey, undefined, () => setAnthropicKey(''))} style={btnSmall}>Save</button>
              </div>
            </div>
            <div style={credBox}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Google OAuth client</div>
                  <div style={{ fontSize: 11.5, color: C.faint, marginTop: 1 }}>
                    The OAuth app clients sign in through. Register redirect URI <span style={{ fontFamily: mono }}>{callbackUrl}</span> in Google Cloud Console.
                    {googleCred && typeof googleCred.meta.clientId === 'string' ? ` Current client: ${googleCred.meta.clientId}` : ''}
                  </div>
                </div>
                {googleCred && <StoredValue cred={googleCred} onRemove={() => void removePlatform('GOOGLE_OAUTH_CLIENT')} />}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <input value={googleId} onChange={(e) => setGoogleId(e.target.value)} placeholder="Client ID (…apps.googleusercontent.com)" style={{ ...credInput, flex: 2, minWidth: 220 }} />
                <input value={googleSecret} onChange={(e) => setGoogleSecret(e.target.value)} type="password" placeholder="Client secret" style={{ ...credInput, flex: 1, minWidth: 160 }} />
                <button
                  onClick={() => {
                    if (!googleId.trim()) { desk.toast('Enter the OAuth client ID too.'); return }
                    void savePlatform('GOOGLE_OAUTH_CLIENT', googleSecret, { clientId: googleId.trim() }, () => { setGoogleId(''); setGoogleSecret('') })
                  }}
                  style={btnSmall}
                >
                  Save
                </button>
              </div>
            </div>
            <div style={credBox}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>App-password fallback (this workspace)</div>
              <div style={{ fontSize: 11.5, color: C.faint, marginTop: 1 }}>
                For mailboxes that can&apos;t use Google sign-in: a Gmail app password (Google Account → Security → 2-Step Verification → App passwords). Sign-in takes priority when both exist.
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <input value={gmailEmail} onChange={(e) => setGmailEmail(e.target.value)} placeholder="inbox@business.com" style={{ ...credInput, flex: 1, minWidth: 180 }} />
                <input value={gmailPass} onChange={(e) => setGmailPass(e.target.value)} type="password" placeholder="16-character app password" style={{ ...credInput, flex: 1, minWidth: 180 }} />
                <button
                  onClick={() => {
                    if (!gmailEmail.trim() || !gmailPass.trim()) { desk.toast('Enter the address and its app password.'); return }
                    void saveWorkspaceSecret('GMAIL_IMAP', gmailPass, { email: gmailEmail.trim() }, () => { setGmailEmail(''); setGmailPass('') })
                  }}
                  style={btnSmall}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Developer-only: external machine access ────────────────────────── */}
      {isDev && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <div style={{ ...sectionTitle, marginBottom: 0 }}>External lead push</div>
            <span style={devBadge}>Developer</span>
          </div>
          <div style={sectionDesc}>
            Machine credentials for anything outside Leadline that pushes already-scored leads to the ingest webhook. Not needed for inbox scanning.
          </div>
          <div style={{ ...credBox, marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Webhook signing secret</div>
                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 1 }}>When set, every ingest call must carry a matching HMAC signature.</div>
              </div>
              {webhookCred && <StoredValue cred={webhookCred} onRemove={() => void desk.removeCredential('N8N_WEBHOOK')} />}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <input value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="Paste value to set or rotate" style={{ ...credInput, flex: 1 }} />
              <button onClick={() => void saveWorkspaceSecret('N8N_WEBHOOK', webhookSecret, undefined, () => setWebhookSecret(''))} style={btnSmall}>Save</button>
            </div>
          </div>
          {st.keyReveal && (
            <div style={{ background: 'rgba(18,67,59,.06)', border: '1px solid rgba(18,67,59,.25)', borderRadius: 10, padding: '13px 15px', marginBottom: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: A }}>Copy this key now — it will not be shown again.</div>
              <div style={{ fontFamily: mono, fontSize: 12.5, background: '#fff', border: `1px solid ${C.border2}`, borderRadius: 7, padding: '8px 10px', marginTop: 8, wordBreak: 'break-all' }}>
                {st.keyReveal.key}
              </div>
              <button onClick={() => set({ keyReveal: null })} style={{ background: 'none', border: 'none', color: A, cursor: 'pointer', fontSize: 12, fontWeight: 600, marginTop: 8, padding: 0 }}>
                I&apos;ve stored it
              </button>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 12 }}>
            {activeKeys.map((k) => (
              <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: C.bg3, borderRadius: 8, padding: '9px 12px', flexWrap: 'wrap' }}>
                <div style={{ width: 7, height: 7, borderRadius: 999, flex: '0 0 auto', background: k.lastUsedAt ? C.ok : C.gold }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{k.name}</span>
                <span style={{ fontFamily: mono, fontSize: 12, color: C.sub }}>{k.prefix}…</span>
                <span style={{ fontSize: 11.5, color: C.faint }}>{k.lastUsedAt ? `Last used ${fmtDate(k.lastUsedAt)}` : 'Never used'}</span>
                <span style={{ fontSize: 11.5, color: C.faint, flex: 1 }}>Created {fmtDate(k.createdAt)}</span>
                <button onClick={() => void desk.revokeKey(k.id)} style={linkDanger}>Revoke</button>
              </div>
            ))}
            {activeKeys.length === 0 && <div style={{ fontSize: 12.5, color: C.faint }}>No ingest API keys — none are needed for inbox scanning.</div>}
          </div>
          <div style={{ display: 'flex', gap: 8, maxWidth: 420 }}>
            <input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="Key name, e.g. Zapier push" style={{ ...inputS, flex: 1 }} />
            <button onClick={() => { void desk.createKey(newKeyName); setNewKeyName('') }} style={btnSmall}>Create key</button>
          </div>
        </div>
      )}
    </div>
  )
}
