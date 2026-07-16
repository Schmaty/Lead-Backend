import { useState, type ReactNode } from 'react'
import { api } from '../api'
import { IX } from '../icons'
import { errMsg, useDesk } from '../store'
import { btnPrimary, C, inputS, serif, upLabel } from '../styles'

export default function ChangePasswordModal(): ReactNode {
  const desk = useDesk()
  const { set } = desk
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = (): void => set({ changePwOpen: false })
  const submit = async (): Promise<void> => {
    if (next !== confirm) {
      setError('New passwords do not match')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.changePassword(current, next)
      close()
      desk.toast('Password changed — other sessions were signed out')
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={close} style={{ position: 'absolute', inset: 0, background: 'rgba(26,26,26,.32)', animation: 'll-scrim .2s ease' }} />
      <div style={{ position: 'relative', width: 'min(420px,100%)', background: '#fff', borderRadius: 16, boxShadow: '0 20px 60px rgba(26,26,26,.24)', animation: 'll-fade .22s ease' }}>
        <div style={{ padding: '20px 24px 14px', borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontFamily: serif, fontSize: 19, fontWeight: 600 }}>Change password</div>
          <button onClick={close} style={{ background: C.bg4, border: 'none', width: 30, height: 30, borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.body }}>
            <IX size={15} strokeWidth={2} />
          </button>
        </div>
        <div style={{ padding: '18px 24px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={upLabel}>Current password</div>
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} style={{ ...inputS, width: '100%' }} autoComplete="current-password" />
          </div>
          <div>
            <div style={upLabel}>New password (12+ characters)</div>
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} style={{ ...inputS, width: '100%' }} autoComplete="new-password" />
          </div>
          <div>
            <div style={upLabel}>Confirm new password</div>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ ...inputS, width: '100%' }} autoComplete="new-password" />
          </div>
          {error && <div style={{ fontSize: 12.5, color: C.danger }}>{error}</div>}
          <div style={{ fontSize: 11.5, color: C.faint }}>Changing your password signs out every other device.</div>
          <button disabled={busy || !current || !next} onClick={() => void submit()} style={{ ...btnPrimary, opacity: busy || !current || !next ? 0.6 : 1 }}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </div>
    </div>
  )
}
