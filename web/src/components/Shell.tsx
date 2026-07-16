import type { CSSProperties, ReactNode } from 'react'
import { initials } from '../compute'
import { IChart, IChevronDown, IChevronUp, IList, IPipeline, IPlus, ISearch, ISliders, ISun, IWarning, IX } from '../icons'
import { useDesk, type Route } from '../store'
import { A, C, btnPrimary, navStyle, serif, shimmer } from '../styles'
import AddLeadModal from './AddLeadModal'
import ChangePasswordModal from './ChangePasswordModal'
import DetailDrawer from './DetailDrawer'
import FilterBar from './FilterBar'
import Analytics from '../views/Analytics'
import Leads from '../views/Leads'
import Pipeline from '../views/Pipeline'
import SettingsView from '../views/Settings'
import Today from '../views/Today'

const NAV: Array<{ key: Route; label: string; icon: (p: { size?: number }) => ReactNode }> = [
  { key: 'today', label: 'Today', icon: ISun },
  { key: 'pipeline', label: 'Pipeline', icon: IPipeline },
  { key: 'leads', label: 'All Leads', icon: IList },
  { key: 'analytics', label: 'Analytics', icon: IChart },
]

const menuBox: CSSProperties = {
  background: '#fff',
  border: `1px solid ${C.border2}`,
  borderRadius: 11,
  boxShadow: '0 12px 32px rgba(26,26,26,.15)',
  padding: 7,
  zIndex: 60,
  animation: 'll-fade .16s ease',
}

const menuItem: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '9px 10px',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
  color: C.text,
}

function Brand({ size = 27 }: { size?: number }): ReactNode {
  return (
    <div
      style={{
        width: size, height: size, borderRadius: size >= 27 ? 7 : 4, background: A,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
      }}
    >
      <div style={{ width: size / 3, height: size / 3, borderRadius: 2, background: C.bg }} />
    </div>
  )
}

function LoadingSkeleton(): ReactNode {
  return (
    <div style={{ padding: 'clamp(20px,3vw,32px)' }}>
      <div style={shimmer(13, { width: 150, borderRadius: 6 })} />
      <div style={shimmer(44, { width: 'min(560px,80%)', marginTop: 16 })} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginTop: 26 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={shimmer(92, { borderRadius: 10 })} />
        ))}
      </div>
      <div style={shimmer(280, { marginTop: 22, borderRadius: 12 })} />
    </div>
  )
}

function ErrorState({ msg, onRetry }: { msg: string; onRetry: () => void }): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '70vh', gap: 14, padding: 40, textAlign: 'center' }}>
      <div style={{ width: 52, height: 52, borderRadius: 999, background: 'rgba(180,35,24,.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.danger }}>
        <IWarning size={26} strokeWidth={1.8} />
      </div>
      <div style={{ fontFamily: serif, fontSize: 23, fontWeight: 600 }}>Couldn&apos;t reach the lead feed</div>
      <div style={{ color: C.sub, maxWidth: 420, fontSize: 14 }}>{msg}</div>
      <button onClick={onRetry} style={{ ...btnPrimary, padding: '10px 20px', marginTop: 4 }}>
        Retry connection
      </button>
    </div>
  )
}

export default function Shell(): ReactNode {
  const desk = useDesk()
  const { st, set, go } = desk
  const user = st.user!
  const ready = !st.loading && !st.error

  const setSearch = (value: string): void => {
    set((s) => {
      const goLeads = !!value && s.route !== 'leads' && s.route !== 'pipeline'
      if (goLeads && location.hash !== '#/leads') location.hash = '#/leads'
      return { search: value, route: goLeads ? 'leads' : s.route, detailId: goLeads ? null : s.detailId }
    })
    setTimeout(() => desk.pushFilterHash(undefined, value), 0)
  }

  return (
    <div id="ll-app" style={{ display: 'flex', minHeight: '100vh', background: C.bg, color: C.text }}>
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside
        id="ll-sidebar"
        style={{ width: 224, flex: '0 0 224px', borderRight: `1px solid ${C.border}`, background: '#fff', display: 'flex', flexDirection: 'column', position: 'sticky', top: 0, height: '100vh', zIndex: 40 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 18px 12px' }}>
          <Brand />
          <div id="ll-brandtext" style={{ fontFamily: serif, fontSize: 19, fontWeight: 600, letterSpacing: '-.01em', color: A }}>
            Leadline
          </div>
        </div>
        <nav id="ll-nav" style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 12px', flex: 1 }}>
          {NAV.map(({ key, label, icon: Icon }) => (
            <div key={key} className="ll-navitem" style={navStyle(st.route === key)} onClick={() => go(key)}>
              <Icon size={18} />
              <span data-nav-label>{label}</span>
            </div>
          ))}
          <div style={{ flex: 1 }} />
          <div className="ll-navitem" style={navStyle(st.route === 'settings')} onClick={() => go('settings')}>
            <ISliders size={18} />
            <span data-nav-label>Settings</span>
          </div>
        </nav>
        <div data-ll-menu style={{ position: 'relative', borderTop: `1px solid ${C.border}` }}>
          <div
            id="ll-acct"
            className="hv-bg"
            onClick={() => set((s) => ({ acctMenuOpen: !s.acctMenuOpen, wsMenuOpen: false }))}
            style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
          >
            <div style={{ width: 31, height: 31, borderRadius: 999, background: 'rgba(18,67,59,.1)', color: A, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flex: '0 0 auto' }}>
              {initials(user.name)}
            </div>
            <div data-nav-label style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.name}</div>
              <div style={{ fontSize: 11, color: C.sub }}>{user.role === 'OWNER' ? 'Owner · admin' : user.role === 'ADMIN' ? 'Admin' : 'Member'}</div>
            </div>
            <span data-nav-label style={{ color: C.faint, display: 'flex' }}>
              <IChevronUp size={15} strokeWidth={1.8} />
            </span>
          </div>
          {st.acctMenuOpen && (
            <div style={{ ...menuBox, position: 'absolute', left: 12, right: 12, bottom: 64, minWidth: 210 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 10px' }}>
                <div style={{ width: 34, height: 34, borderRadius: 999, background: 'rgba(18,67,59,.1)', color: A, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flex: '0 0 auto' }}>
                  {initials(user.name)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.name}</div>
                  <div style={{ fontSize: 11, color: C.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.email}</div>
                </div>
              </div>
              <div style={{ height: 1, background: C.line, margin: '1px 4px 4px' }} />
              <div className="hv-bg" style={menuItem} onClick={() => { set({ acctMenuOpen: false }); go('settings') }}>
                <ISliders size={15} strokeWidth={1.8} />
                Settings
              </div>
              <div className="hv-bg" style={menuItem} onClick={() => set({ acctMenuOpen: false, changePwOpen: true })}>
                Change password
              </div>
              <div className="hv-bg" style={{ ...menuItem, color: C.danger }} onClick={() => void desk.logout()}>
                Sign out
              </div>
            </div>
          )}
        </div>
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* ── Topbar ───────────────────────────────────────────────────── */}
        <header
          id="ll-topbar"
          style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px clamp(16px,3vw,28px)', borderBottom: `1px solid ${C.border}`, background: 'rgba(250,250,247,.82)', backdropFilter: 'blur(8px)', position: 'sticky', top: 0, zIndex: 30, minHeight: 60 }}
        >
          <div data-ll-menu style={{ position: 'relative', flex: '0 0 auto' }}>
            <div
              className="hv-accentborder"
              onClick={() => set((s) => ({ wsMenuOpen: !s.wsMenuOpen, acctMenuOpen: false }))}
              style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 11px', border: `1px solid ${C.border}`, borderRadius: 8, background: '#fff', cursor: 'pointer' }}
            >
              <Brand size={17} />
              <span id="ll-ws-label" style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>{st.workspaceName || '…'}</span>
              <span style={{ color: C.sub, display: 'flex' }}>
                <IChevronDown size={14} strokeWidth={1.8} />
              </span>
            </div>
            {st.wsMenuOpen && (
              <div style={{ ...menuBox, position: 'absolute', left: 0, top: 46, width: 250 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: C.faint, padding: '7px 10px 5px' }}>Workspace</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(18,67,59,.06)' }}>
                  <Brand size={26} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{st.workspaceName}</div>
                    <div style={{ fontSize: 11, color: C.sub }}>Current lead desk</div>
                  </div>
                  <span style={{ color: A, display: 'flex' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  </span>
                </div>
                <div style={{ fontSize: 11, color: C.faint, padding: '8px 10px 6px', lineHeight: 1.45 }}>
                  One workspace per business — Leadline is your single lead desk.
                </div>
                <div style={{ height: 1, background: C.line, margin: '3px 4px' }} />
                <div className="hv-bg" style={menuItem} onClick={() => { set({ wsMenuOpen: false }); go('settings') }}>
                  <ISliders size={15} strokeWidth={1.8} />
                  Workspace settings
                </div>
              </div>
            )}
          </div>
          <div id="ll-topsearch" style={{ flex: 1, maxWidth: 440, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, background: '#fff' }}>
            <span style={{ color: C.sub, display: 'flex', flex: '0 0 auto' }}>
              <ISearch size={16} strokeWidth={1.8} />
            </span>
            <input
              value={st.search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search leads, orgs, notes…"
              style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 13.5, width: '100%' }}
            />
            {!!st.search && (
              <div
                onClick={() => { set({ search: '' }); setTimeout(() => desk.pushFilterHash(undefined, ''), 0) }}
                style={{ flex: '0 0 auto', width: 18, height: 18, borderRadius: 999, background: C.bg4, color: C.sub, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}
              >
                ×
              </div>
            )}
          </div>
          <div style={{ flex: 1 }} />
          <button className="hv-dark" onClick={() => set({ addOpen: true })} style={{ ...btnPrimary, display: 'flex', alignItems: 'center', gap: 7, flex: '0 0 auto', transition: 'background .15s' }}>
            <IPlus size={16} strokeWidth={2} />
            <span>Add lead</span>
          </button>
        </header>

        {ready && (st.route === 'leads' || st.route === 'pipeline') && <FilterBar />}

        <main id="ll-main" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {st.loading && <LoadingSkeleton />}
          {!st.loading && st.error && <ErrorState msg={st.error} onRetry={() => void desk.loadAll()} />}
          {ready && st.route === 'today' && <Today />}
          {ready && st.route === 'pipeline' && <Pipeline />}
          {ready && st.route === 'leads' && <Leads />}
          {ready && st.route === 'analytics' && <Analytics />}
          {ready && st.route === 'settings' && <SettingsView />}
          {ready && st.route === '404' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '70vh', gap: 12, padding: 40, textAlign: 'center' }}>
              <div style={{ fontFamily: serif, fontSize: 72, fontWeight: 600, color: A, lineHeight: 1 }}>404</div>
              <div style={{ color: C.sub, fontSize: 15 }}>That page doesn&apos;t exist in Leadline.</div>
              <button onClick={() => go('today')} style={{ ...btnPrimary, padding: '10px 20px', marginTop: 6 }}>
                Back to Today
              </button>
            </div>
          )}
        </main>
      </div>

      {st.detailId && <DetailDrawer />}
      {st.addOpen && <AddLeadModal />}
      {st.changePwOpen && <ChangePasswordModal />}

      <div style={{ position: 'fixed', right: 20, bottom: 20, display: 'flex', flexDirection: 'column', gap: 10, zIndex: 300, pointerEvents: 'none' }}>
        {st.toasts.map((t) => (
          <div key={t.id} style={{ background: A, color: '#fff', padding: '11px 16px', borderRadius: 9, fontSize: 13.5, fontWeight: 500, boxShadow: '0 10px 28px rgba(26,26,26,.18)', animation: 'll-toast .22s cubic-bezier(.22,1,.36,1)', maxWidth: 340 }}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  )
}
