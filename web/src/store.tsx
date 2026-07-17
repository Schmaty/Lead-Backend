import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, tryRefresh } from './api'
import {
  defaultColumns,
  defaultFilters,
  type ApiKeyRow,
  type Columns,
  type CredentialRow,
  type Filters,
  type Lead,
  type Role,
  type SessionUser,
  type Settings,
  type SortState,
  type UserInfo,
} from './types'

export type Route = 'today' | 'pipeline' | 'leads' | 'analytics' | 'settings' | '404'
export type AuthRoute = 'login' | 'signup' | 'forgot' | 'reset' | 'accept-invite'

const APP_ROUTES: Route[] = ['today', 'pipeline', 'leads', 'analytics', 'settings']
const AUTH_ROUTES: AuthRoute[] = ['login', 'signup', 'forgot', 'reset', 'accept-invite']

export interface AddForm {
  name: string
  email: string
  org: string
  source: string
  inquiryType: string
  summary: string
  dealLow: string
  dealHigh: string
  leadScore: number
}

export interface DeskState {
  booting: boolean
  user: SessionUser | null
  workspaceName: string
  authRoute: AuthRoute
  authToken: string
  loading: boolean
  error: string | null
  leads: Lead[]
  settings: Settings | null
  users: UserInfo[]
  credentials: CredentialRow[]
  apiKeys: ApiKeyRow[]
  adminDataLoaded: boolean
  route: Route
  detailId: string | null
  search: string
  filters: Filters
  sort: SortState
  selection: string[]
  columns: Columns
  density: 'comfortable' | 'compact'
  filtersOpen: boolean
  colMenuOpen: boolean
  wsMenuOpen: boolean
  acctMenuOpen: boolean
  settingsTab: string
  addOpen: boolean
  addForm: AddForm
  analyticsRange: '30' | '60' | '90' | 'all'
  draftEdits: Record<string, string>
  notesEdits: Record<string, string>
  dragId: string | null
  dragOver: string | null
  toasts: Array<{ id: number; msg: string }>
  keyReveal: { name: string; key: string } | null
  inviteResult: { email: string; role: string; url: string } | null
  changePwOpen: boolean
  now: Date
}

export const blankAdd = (settings: Settings | null): AddForm => ({
  name: '',
  email: '',
  org: '',
  source: settings?.sources[0] ?? 'Website form',
  inquiryType: settings?.inquiryTypes.find((t) => /general|other/i.test(t)) ?? settings?.inquiryTypes[0] ?? 'Other',
  summary: '',
  dealLow: '',
  dealHigh: '',
  leadScore: 5,
})

function initialState(): DeskState {
  return {
    booting: true,
    user: null,
    workspaceName: '',
    authRoute: 'login',
    authToken: '',
    loading: true,
    error: null,
    leads: [],
    settings: null,
    users: [],
    credentials: [],
    apiKeys: [],
    adminDataLoaded: false,
    route: 'today',
    detailId: null,
    search: '',
    filters: defaultFilters(),
    sort: { col: 'received', dir: 'desc' },
    selection: [],
    columns: defaultColumns(),
    density: 'comfortable',
    filtersOpen: false,
    colMenuOpen: false,
    wsMenuOpen: false,
    acctMenuOpen: false,
    settingsTab: 'connection',
    addOpen: false,
    addForm: blankAdd(null),
    analyticsRange: 'all',
    draftEdits: {},
    notesEdits: {},
    dragId: null,
    dragOver: null,
    toasts: [],
    keyReveal: null,
    inviteResult: null,
    changePwOpen: false,
    now: new Date(),
  }
}

type Patch = Partial<DeskState> | ((s: DeskState) => Partial<DeskState>)

export interface Desk {
  st: DeskState
  set: (p: Patch) => void
  toast: (msg: string) => void
  go: (route: Route) => void
  goAuth: (route: AuthRoute) => void
  pushFilterHash: (filters?: Filters, search?: string) => void
  canAdmin: boolean
  // data actions
  loadAll: () => Promise<void>
  refreshLeads: () => Promise<void>
  updateLead: (id: string, patch: Record<string, unknown>) => Promise<boolean>
  addLead: (form: AddForm) => Promise<void>
  deleteLead: (id: string) => Promise<void>
  bulkDelete: (ids: string[]) => Promise<void>
  bulk: (ids: string[], patch: Record<string, unknown>, label: string) => Promise<void>
  markSent: (id: string, stage: string) => Promise<void>
  saveSettings: (patch: Record<string, unknown>) => Promise<boolean>
  loadAdminData: () => Promise<void>
  saveCredential: (kind: string, value: string, meta?: Record<string, unknown>) => Promise<void>
  removeCredential: (kind: string) => Promise<void>
  createKey: (name: string) => Promise<void>
  revokeKey: (id: string) => Promise<void>
  invite: (email: string, role: Role) => Promise<void>
  // auth actions
  login: (email: string, password: string) => Promise<void>
  signup: (workspaceName: string, name: string, email: string, password: string) => Promise<void>
  acceptInvite: (token: string, name: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const DeskContext = createContext<Desk | null>(null)

export function useDesk(): Desk {
  const desk = useContext(DeskContext)
  if (!desk) throw new Error('useDesk outside provider')
  return desk
}

export const errMsg = (e: unknown): string =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong'

export function DeskProvider({ children }: { children: ReactNode }): ReactNode {
  const [st, setSt] = useState<DeskState>(initialState)
  const stRef = useRef(st)
  stRef.current = st

  const set = (p: Patch): void => setSt((s) => ({ ...s, ...(typeof p === 'function' ? p(s) : p) }))

  const toast = (msg: string): void => {
    const id = Date.now() + Math.random()
    set((s) => ({ toasts: [...s.toasts, { id, msg }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2800)
  }

  // ── hash routing (filters + search serialized on leads/pipeline) ─────────
  const nonDefaultFilters = (f: Filters): Partial<Filters> => {
    const d = defaultFilters()
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(d) as Array<keyof Filters>) {
      if (JSON.stringify(f[key]) !== JSON.stringify(d[key])) out[key] = f[key]
    }
    return out as Partial<Filters>
  }

  const pushFilterHash = (filters?: Filters, search?: string): void => {
    const s = stRef.current
    const route = s.route
    if (route !== 'leads' && route !== 'pipeline') return
    try {
      const nd = nonDefaultFilters(filters ?? s.filters)
      const params = new URLSearchParams()
      if (Object.keys(nd).length > 0) params.set('f', JSON.stringify(nd))
      const q = search ?? s.search
      if (q) params.set('q', q)
      const qs = params.toString()
      history.replaceState(null, '', `#/${route}${qs ? '?' + qs : ''}`)
    } catch {
      /* URL state is best-effort */
    }
  }

  const syncFromHash = (): void => {
    const h = (location.hash || '').replace(/^#\/?/, '')
    const [path = '', qs] = h.split('?')
    if (!stRef.current.user) {
      const authRoute = (AUTH_ROUTES as string[]).includes(path) ? (path as AuthRoute) : 'login'
      const token = qs ? (new URLSearchParams(qs).get('token') ?? '') : ''
      set({ authRoute, authToken: token })
      return
    }
    let route: Route
    if (!path) route = 'today'
    else if ((APP_ROUTES as string[]).includes(path)) route = path as Route
    else route = '404'
    const patch: Partial<DeskState> = { route, detailId: null }
    if (qs) {
      try {
        const params = new URLSearchParams(qs)
        const f = params.get('f')
        if (f) patch.filters = { ...defaultFilters(), ...(JSON.parse(f) as Partial<Filters>) }
        const q = params.get('q')
        if (q != null) patch.search = q
      } catch {
        /* ignore malformed filter payloads */
      }
    }
    set(patch)
  }

  const go = (route: Route): void => {
    if ((location.hash || '') !== `#/${route}`) location.hash = `#/${route}`
    set({ route, detailId: null, selection: [], wsMenuOpen: false, acctMenuOpen: false })
  }

  const goAuth = (route: AuthRoute): void => {
    if ((location.hash || '') !== `#/${route}`) location.hash = `#/${route}`
    set({ authRoute: route })
  }

  // ── data loading ──────────────────────────────────────────────────────────
  const loadAll = async (): Promise<void> => {
    set({ loading: true, error: null })
    try {
      const [ws, listed] = await Promise.all([api.workspace(), api.listLeadsAll()])
      set({
        loading: false,
        settings: ws.settings,
        users: ws.users,
        workspaceName: ws.name,
        leads: listed.leads,
        addForm: blankAdd(ws.settings),
        now: new Date(),
      })
      syncFromHash()
    } catch (e) {
      set({ loading: false, error: errMsg(e) })
    }
  }

  const refreshLeads = async (): Promise<void> => {
    try {
      const [ws, listed] = await Promise.all([api.workspace(), api.listLeadsAll()])
      set({ leads: listed.leads, settings: ws.settings, users: ws.users, workspaceName: ws.name, now: new Date() })
    } catch {
      /* silent background refresh */
    }
  }

  // ── lead mutations ────────────────────────────────────────────────────────
  const updateLead = async (id: string, patch: Record<string, unknown>): Promise<boolean> => {
    try {
      await api.patchLead(id, patch)
      const fresh = await api.getLead(id)
      set((s) => ({ leads: s.leads.map((l) => (l.id === id ? fresh : l)), now: new Date() }))
      return true
    } catch (e) {
      toast(errMsg(e))
      return false
    }
  }

  const addLead = async (form: AddForm): Promise<void> => {
    const hasDeal = form.dealLow !== '' || form.dealHigh !== ''
    try {
      const lead = await api.createLead({
        name: form.name || 'Unknown sender',
        email: form.email,
        org: form.org,
        source: form.source,
        inquiryType: form.inquiryType,
        summary: form.summary,
        leadScore: Number(form.leadScore) || 5,
        dealValueLow: Number(form.dealLow) || 0,
        dealValueHigh: Number(form.dealHigh) || 0,
        recommendedNextStep: 'Review and triage this new lead.',
        ...(hasDeal ? {} : { inferredFields: ['dealValueLow', 'dealValueHigh'] }),
      })
      set((s) => ({
        leads: [lead, ...s.leads],
        addOpen: false,
        addForm: blankAdd(s.settings),
        detailId: lead.id,
        now: new Date(),
      }))
      toast('Lead added')
    } catch (e) {
      toast(errMsg(e))
    }
  }

  const deleteLead = async (id: string): Promise<void> => {
    try {
      await api.deleteLead(id)
      set((s) => ({ leads: s.leads.filter((l) => l.id !== id), detailId: null }))
      toast('Lead deleted')
    } catch (e) {
      toast(errMsg(e))
    }
  }

  const bulkDelete = async (ids: string[]): Promise<void> => {
    let deleted = 0
    try {
      for (const id of ids) {
        await api.deleteLead(id)
        deleted++
      }
    } catch (e) {
      toast(errMsg(e))
    }
    if (deleted > 0) {
      set((s) => ({
        leads: s.leads.filter((l) => !ids.includes(l.id)),
        selection: [],
        detailId: s.detailId && ids.includes(s.detailId) ? null : s.detailId,
      }))
      toast(`Deleted ${deleted} lead${deleted === 1 ? '' : 's'}`)
    }
  }

  const bulk = async (ids: string[], patch: Record<string, unknown>, label: string): Promise<void> => {
    try {
      for (const id of ids) await api.patchLead(id, patch)
      toast(`${label} for ${ids.length} lead${ids.length === 1 ? '' : 's'}`)
    } catch (e) {
      toast(errMsg(e))
    }
    set({ selection: [] })
    await refreshLeads()
  }

  const markSent = async (id: string, stage: string): Promise<void> => {
    const settings = stRef.current.settings
    const patch: Record<string, unknown> = { replySent: true }
    if (settings) {
      const repliedIdx = settings.stages.indexOf('Replied')
      const currentIdx = settings.stages.indexOf(stage)
      if (repliedIdx >= 0 && currentIdx >= 0 && currentIdx < repliedIdx) patch.stage = 'Replied'
    }
    if (await updateLead(id, patch)) toast('Reply marked as sent')
  }

  // ── settings & admin data ────────────────────────────────────────────────
  const saveSettings = async (patch: Record<string, unknown>): Promise<boolean> => {
    try {
      const out = await api.patchSettings(patch)
      set({ settings: out.settings })
      if (out.recomputedLeads > 0 || out.renamedStages > 0) void refreshLeads()
      return true
    } catch (e) {
      toast(errMsg(e))
      return false
    }
  }

  const loadAdminData = async (): Promise<void> => {
    if (stRef.current.user?.role === 'MEMBER') return
    // API keys are developer-only — a plain OWNER/ADMIN gets 403 there but
    // must still see credential status, so the two loads are independent.
    try {
      const creds = await api.credentials()
      set({ credentials: creds.credentials, adminDataLoaded: true })
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 403)) toast(errMsg(e))
    }
    try {
      const keys = await api.apiKeys()
      set({ apiKeys: keys.apiKeys })
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 403)) toast(errMsg(e))
    }
  }

  const saveCredential = async (kind: string, value: string, meta?: Record<string, unknown>): Promise<void> => {
    try {
      await api.putCredential(kind, value, meta)
      const creds = await api.credentials()
      set({ credentials: creds.credentials })
      toast('Credential stored. Only the masked value stays readable.')
    } catch (e) {
      toast(errMsg(e))
    }
  }

  const removeCredential = async (kind: string): Promise<void> => {
    try {
      await api.deleteCredential(kind)
      set((s) => ({ credentials: s.credentials.filter((c) => c.kind !== kind) }))
    } catch (e) {
      toast(errMsg(e))
    }
  }

  const createKey = async (name: string): Promise<void> => {
    try {
      const out = await api.createApiKey(name || 'n8n ingest')
      const keys = await api.apiKeys()
      set({ apiKeys: keys.apiKeys, keyReveal: { name: out.name, key: out.key } })
    } catch (e) {
      toast(errMsg(e))
    }
  }

  const revokeKey = async (id: string): Promise<void> => {
    try {
      await api.revokeApiKey(id)
      const keys = await api.apiKeys()
      set({ apiKeys: keys.apiKeys })
      toast('API key revoked')
    } catch (e) {
      toast(errMsg(e))
    }
  }

  const invite = async (email: string, role: Role): Promise<void> => {
    try {
      const out = await api.invite(email, role)
      set({ inviteResult: { email, role, url: out.inviteUrl } })
      if (out.emailed) toast('Invite emailed')
    } catch (e) {
      toast(errMsg(e))
    }
  }

  // ── auth ──────────────────────────────────────────────────────────────────
  const enterSession = async (user: SessionUser): Promise<void> => {
    set({ user, booting: false })
    location.hash = '#/today'
    set({ route: 'today' })
    await loadAll()
  }

  const login = async (email: string, password: string): Promise<void> => {
    await enterSession(await api.login(email, password))
  }
  const signup = async (workspaceName: string, name: string, email: string, password: string): Promise<void> => {
    await enterSession(await api.signup({ workspaceName, name, email, password }))
  }
  const acceptInvite = async (token: string, name: string, password: string): Promise<void> => {
    await enterSession(await api.acceptInvite(token, name, password))
  }
  const logout = async (): Promise<void> => {
    try {
      await api.logout()
    } catch {
      /* session is gone either way */
    }
    const fresh = initialState()
    setSt({ ...fresh, booting: false, user: null })
    location.hash = '#/login'
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  useEffect(() => {
    const onHash = (): void => syncFromHash()
    window.addEventListener('hashchange', onHash)
    const onDocClick = (e: MouseEvent): void => {
      const s = stRef.current
      if (!s.wsMenuOpen && !s.acctMenuOpen && !s.colMenuOpen) return
      const target = e.target as Element | null
      if (target?.closest?.('[data-ll-menu]')) return
      set({ wsMenuOpen: false, acctMenuOpen: false, colMenuOpen: false })
    }
    document.addEventListener('mousedown', onDocClick, true)

    void (async () => {
      const session = await tryRefresh()
      if (!session) {
        set({ booting: false, loading: false })
        syncFromHash()
        return
      }
      set({ user: session.user, booting: false })
      await loadAll()
    })()

    const tick = setInterval(() => {
      if (stRef.current.user && !document.hidden) void refreshLeads()
    }, 60_000)
    const clock = setInterval(() => set({ now: new Date() }), 30_000)
    return () => {
      window.removeEventListener('hashchange', onHash)
      document.removeEventListener('mousedown', onDocClick, true)
      clearInterval(tick)
      clearInterval(clock)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const desk: Desk = {
    st,
    set,
    toast,
    go,
    goAuth,
    pushFilterHash,
    canAdmin: st.user?.role === 'OWNER' || st.user?.role === 'ADMIN',
    loadAll,
    refreshLeads,
    updateLead,
    addLead,
    deleteLead,
    bulkDelete,
    bulk,
    markSent,
    saveSettings,
    loadAdminData,
    saveCredential,
    removeCredential,
    createKey,
    revokeKey,
    invite,
    login,
    signup,
    acceptInvite,
    logout,
  }

  return <DeskContext.Provider value={desk}>{children}</DeskContext.Provider>
}
