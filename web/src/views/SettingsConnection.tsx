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
  const [gmailEmail, setGmailEmail] = useState('')
  const [gmailPass, setGmailPass] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [newKeyName, setNewKeyName] = useState('')
  const [scan, setScan] = useState<ScanStatus | null>(null)
  const pollRef = useRef<number | null>(null)

  const findCred = (kind: string): CredentialRow | undefined => st.credentials.find((c) => c.kind === kind)
  const gmailCred = findCred('GMAIL_IMAP')
  const anthropicCred = findCred('ANTHROPIC_API_KEY')
  const webhookCred = findCred('N8N_WEBHOOK')
  const configured = scan?.configured ?? (!!gmailCred && !!anthropicCred)
  const gmailAddress = typeof gmailCred?.meta.email === 'string' ? gmailCred.meta.email : ''

  const loadStatus = async (): Promise<void> => {
    const status = await api.scanStatus().catch(() => null)
    if (status) setScan(status)
  }
  useEffect(() => {
    void loadStatus()
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
        else if (status.lastResult) desk.toast(`Scan complete — ${status.lastResult.imported} new, ${status.lastResult.updated} updated`)
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

  const saveGmail = async (): Promise<void> => {
    const email = gmailEmail.trim() || gmailAddress
    const pass = gmailPass.trim()
    if (!email || !pass) { desk.toast('Enter the Gmail address and its app password.'); return }
    await desk.saveCredential('GMAIL_IMAP', pass, { email })
    setGmailEmail(''); setGmailPass('')
    void loadStatus()
  }
  const saveSimple = async (kind: string, value: string, clear: () => void): Promise<void> => {
    if (!value.trim()) { desk.toast('Paste a value first — secrets are write-only.'); return }
    await desk.saveCredential(kind, value.trim())
    clear()
    void loadStatus()
  }
  const remove = async (kind: string): Promise<void> => {
    await desk.removeCredential(kind)
    void loadStatus()
  }

  const activeKeys = st.apiKeys.filter((k) => !k.revokedAt)
  const lastResult = scan?.lastResult ?? null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={sectionTitle}>Inbox scanning</div>
        <div style={sectionDesc}>
          Leadline reads your inbox on a schedule, scores each new inquiry with Claude, and files it here — everything lives in Leadline&apos;s own database. Both secrets are encrypted at rest and write-only.
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, background: C.bg3, borderRadius: 10, padding: '13px 15px', marginBottom: 18 }}>
          <div style={{ width: 9, height: 9, borderRadius: 999, flex: '0 0 auto', marginTop: 5, background: configured ? C.ok : C.gold }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {scan?.running ? 'Scanning now…' : configured ? 'Inbox scanning armed' : 'Not scanning yet'}
            </div>
            <div style={{ fontSize: 12, color: C.sub, marginTop: 2, lineHeight: 1.45 }}>
              {configured
                ? scan?.lastScanAt
                  ? `Last scan ${fmtDate(scan.lastScanAt)}${lastResult ? ` — ${lastResult.imported} new, ${lastResult.updated} updated, ${lastResult.skipped} skipped${lastResult.errors.length ? `, ${lastResult.errors.length} errors` : ''}` : ''}`
                  : 'Ready — the first scan reads the last 7 days of mail.'
                : 'Connect the Gmail mailbox and an Anthropic API key below to start.'}
            </div>
            {scan?.lastError && <div style={{ fontSize: 12, color: C.danger, marginTop: 4 }}>Last scan failed: {scan.lastError}</div>}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={credBox}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Gmail mailbox{gmailAddress ? ` — ${gmailAddress}` : ''}</div>
                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 1 }}>
                  The inbox that receives inquiries. Use a Google app password: Google Account → Security → 2-Step Verification → App passwords.
                </div>
              </div>
              {gmailCred && <StoredValue cred={gmailCred} onRemove={() => void remove('GMAIL_IMAP')} />}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <input value={gmailEmail} onChange={(e) => setGmailEmail(e.target.value)} placeholder={gmailAddress || 'you@gmail.com'} style={{ ...credInput, flex: 1, minWidth: 180 }} />
              <input value={gmailPass} onChange={(e) => setGmailPass(e.target.value)} type="password" placeholder="16-character app password" style={{ ...credInput, flex: 1, minWidth: 180 }} />
              <button onClick={() => void saveGmail()} style={btnSmall}>Save</button>
            </div>
          </div>
          <div style={credBox}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Anthropic API key</div>
                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 1 }}>Scores each email, categorizes it, and drafts the reply. Create one at console.anthropic.com.</div>
              </div>
              {anthropicCred && <StoredValue cred={anthropicCred} onRemove={() => void remove('ANTHROPIC_API_KEY')} />}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <input value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} type="password" placeholder="sk-ant-…" style={{ ...credInput, flex: 1 }} />
              <button onClick={() => void saveSimple('ANTHROPIC_API_KEY', anthropicKey, () => setAnthropicKey(''))} style={btnSmall}>Save</button>
            </div>
          </div>
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

      <div style={card}>
        <div style={sectionTitle}>External lead push (optional)</div>
        <div style={sectionDesc}>
          For scripts or other tools that deliver already-scored leads to the ingest webhook. Not needed for inbox scanning — leave this empty unless something outside Leadline pushes leads in.
        </div>
        <div style={{ ...credBox, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Webhook signing secret</div>
              <div style={{ fontSize: 11.5, color: C.faint, marginTop: 1 }}>When set, every ingest call must carry a matching HMAC signature.</div>
            </div>
            {webhookCred && <StoredValue cred={webhookCred} onRemove={() => void remove('N8N_WEBHOOK')} />}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="Paste value to set or rotate" style={{ ...credInput, flex: 1 }} />
            <button onClick={() => void saveSimple('N8N_WEBHOOK', webhookSecret, () => setWebhookSecret(''))} style={btnSmall}>Save</button>
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
    </div>
  )
}
