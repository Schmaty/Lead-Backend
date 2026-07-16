import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { api } from '../api'
import { errMsg, useDesk, type AuthRoute } from '../store'
import { A, btnPrimary, C, serif, upLabel } from '../styles'

const field: CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: `1px solid ${C.border2}`,
  borderRadius: 8,
  fontSize: 13.5,
  background: '#fff',
  outline: 'none',
}

function TitleBlock({ title, sub }: { title: string; sub: string }): ReactNode {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 26 }}>
        <div style={{ width: 27, height: 27, borderRadius: 7, background: A, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 9, height: 9, borderRadius: 2, background: C.bg }} />
        </div>
        <div style={{ fontFamily: serif, fontSize: 19, fontWeight: 600, letterSpacing: '-.01em', color: A }}>Leadline</div>
      </div>
      <div style={{ fontFamily: serif, fontSize: 24, fontWeight: 600, lineHeight: 1.2 }}>{title}</div>
      <div style={{ fontSize: 13, color: C.sub, marginTop: 6, marginBottom: 22, lineHeight: 1.5 }}>{sub}</div>
    </>
  )
}

export default function AuthView(): ReactNode {
  const desk = useDesk()
  const { st, goAuth } = desk
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const route: AuthRoute = st.authRoute

  const run = (fn: () => Promise<void>) => async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  const swap = (r: AuthRoute): void => {
    setError(null)
    setNotice(null)
    setPassword('')
    setConfirm('')
    goAuth(r)
  }

  const submitLabel = busy ? 'Working…' : route === 'login' ? 'Sign in' : route === 'signup' ? 'Create workspace' : route === 'forgot' ? 'Send reset link' : route === 'reset' ? 'Set new password' : 'Join workspace'

  const forms: Record<AuthRoute, { title: string; sub: string; body: ReactNode; onSubmit: (e: FormEvent) => Promise<void> }> = {
    login: {
      title: 'Sign in to your lead desk',
      sub: 'Your team’s inbound leads, scored and triaged in one place.',
      onSubmit: run(async () => desk.login(email, password)),
      body: (
        <>
          <div style={{ marginBottom: 14 }}>
            <div style={upLabel}>Email</div>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={field} autoComplete="email" autoFocus />
          </div>
          <div style={{ marginBottom: 6 }}>
            <div style={upLabel}>Password</div>
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} style={field} autoComplete="current-password" />
          </div>
          <div style={{ textAlign: 'right', marginBottom: 18 }}>
            <span onClick={() => swap('forgot')} style={{ fontSize: 12.5, color: A, fontWeight: 600, cursor: 'pointer' }}>Forgot password?</span>
          </div>
        </>
      ),
    },
    signup: {
      title: 'Create your workspace',
      sub: 'One workspace per business — you become its owner.',
      onSubmit: run(async () => desk.signup(workspaceName, name, email, password)),
      body: (
        <>
          <div style={{ marginBottom: 14 }}>
            <div style={upLabel}>Business / workspace name</div>
            <input required value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} style={field} autoFocus />
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={upLabel}>Your name</div>
            <input required value={name} onChange={(e) => setName(e.target.value)} style={field} autoComplete="name" />
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={upLabel}>Email</div>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={field} autoComplete="email" />
          </div>
          <div style={{ marginBottom: 18 }}>
            <div style={upLabel}>Password (12+ characters)</div>
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} style={field} autoComplete="new-password" />
          </div>
        </>
      ),
    },
    forgot: {
      title: 'Reset your password',
      sub: 'Enter your email — if an account exists, a reset link is issued. Without email configured, your admin can fetch the link from the server log.',
      onSubmit: run(async () => {
        await api.resetRequest(email)
        setNotice('If that account exists, a reset link has been issued. Check your inbox (or ask your operator).')
      }),
      body: (
        <div style={{ marginBottom: 18 }}>
          <div style={upLabel}>Email</div>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={field} autoComplete="email" autoFocus />
        </div>
      ),
    },
    reset: {
      title: 'Choose a new password',
      sub: 'This link is single-use and expires quickly.',
      onSubmit: run(async () => {
        if (password !== confirm) throw new Error('Passwords do not match')
        await api.resetPassword(st.authToken, password)
        setNotice('Password updated — sign in with it now.')
        setTimeout(() => swap('login'), 1200)
      }),
      body: (
        <>
          <div style={{ marginBottom: 14 }}>
            <div style={upLabel}>New password (12+ characters)</div>
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} style={field} autoComplete="new-password" autoFocus />
          </div>
          <div style={{ marginBottom: 18 }}>
            <div style={upLabel}>Confirm password</div>
            <input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} style={field} autoComplete="new-password" />
          </div>
        </>
      ),
    },
    'accept-invite': {
      title: 'Join your team on Leadline',
      sub: 'Set your name and a password to accept the invite.',
      onSubmit: run(async () => desk.acceptInvite(st.authToken, name, password)),
      body: (
        <>
          <div style={{ marginBottom: 14 }}>
            <div style={upLabel}>Your name</div>
            <input required value={name} onChange={(e) => setName(e.target.value)} style={field} autoComplete="name" autoFocus />
          </div>
          <div style={{ marginBottom: 18 }}>
            <div style={upLabel}>Password (12+ characters)</div>
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} style={field} autoComplete="new-password" />
          </div>
          {!st.authToken && (
            <div style={{ fontSize: 12.5, color: C.danger, marginBottom: 14 }}>
              This page needs an invite link (…#/accept-invite?token=…). Ask your admin to send one.
            </div>
          )}
        </>
      ),
    },
  }

  const form = forms[route]

  return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: 'min(400px,100%)' }}>
        <form
          onSubmit={(e) => void form.onSubmit(e)}
          style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 16, padding: '30px 30px 26px', boxShadow: '0 1px 2px rgba(26,26,26,.04)', animation: 'll-fade .3s ease' }}
        >
          <TitleBlock title={form.title} sub={form.sub} />
          {form.body}
          {error && <div style={{ fontSize: 12.5, color: C.danger, marginBottom: 14 }}>{error}</div>}
          {notice && <div style={{ fontSize: 12.5, color: C.ok, marginBottom: 14 }}>{notice}</div>}
          <button type="submit" disabled={busy} className="hv-dark" style={{ ...btnPrimary, width: '100%', padding: '11px 15px', opacity: busy ? 0.7 : 1 }}>
            {submitLabel}
          </button>
        </form>
        <div style={{ textAlign: 'center', fontSize: 12.5, color: C.sub, marginTop: 16 }}>
          {route === 'login' ? (
            <>
              New here?{' '}
              <span onClick={() => swap('signup')} style={{ color: A, fontWeight: 600, cursor: 'pointer' }}>Create a workspace</span>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <span onClick={() => swap('login')} style={{ color: A, fontWeight: 600, cursor: 'pointer' }}>Sign in</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
