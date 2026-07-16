import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { fmtDate } from '../compute'
import { useDesk } from '../store'
import { btnSmall, C, card, inputS, linkDanger, mono, rolePill, serif, upLabel } from '../styles'
import type { Role, WinBand } from '../types'
import ConnectionTab from './SettingsConnection'

const A = '#12433B'

const sectionDesc: CSSProperties = { fontSize: 12, color: C.faint, marginBottom: 16, lineHeight: 1.5, maxWidth: '62ch' }
const sectionTitle: CSSProperties = { fontWeight: 600, fontSize: 15, marginBottom: 3 }
const numInput: CSSProperties = { width: 72, padding: '8px 10px', border: `1px solid ${C.border2}`, borderRadius: 8, fontSize: 13.5, fontFamily: mono }

/** Number input that PATCHes on blur / Enter, not per keystroke. */
function NumField({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (v: number) => void }): ReactNode {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = Number(draft)
    if (!Number.isNaN(n) && n >= min && n <= max && n !== value) onCommit(n)
    else setDraft(String(value))
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      style={numInput}
    />
  )
}

/** Winner bands displayed as ranges: sorted desc, hi = previous band's min - 1. */
function bandLabels(map: WinBand[]): Array<{ band: WinBand; label: string }> {
  const sorted = [...map].sort((a, b) => b.min - a.min)
  return sorted.map((band, i) => ({
    band,
    label: `${band.min}-${i === 0 ? 10 : sorted[i - 1]!.min - 1}`,
  }))
}

export default function SettingsView(): ReactNode {
  const desk = useDesk()
  const { st, set, canAdmin } = desk
  const settings = st.settings!
  const [stageDrafts, setStageDrafts] = useState<Record<number, string>>({})
  const [newSource, setNewSource] = useState('')
  const [newType, setNewType] = useState('')
  const [invEmail, setInvEmail] = useState('')
  const [invRole, setInvRole] = useState<Role>('MEMBER')

  useEffect(() => {
    if (canAdmin && !st.adminDataLoaded) void desk.loadAdminData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tab = st.settingsTab
  const tabs: Array<[string, string]> = [
    ...(canAdmin ? ([['connection', 'Connection']] as Array<[string, string]>) : []),
    ['ai', 'AI & scoring'],
    ['pipeline', 'Pipeline stages'],
    ['team', 'Team & sources'],
    ['notifications', 'Notifications'],
  ]
  const activeTab = tabs.some(([id]) => id === tab) ? tab : tabs[0]![0]

  const gated: CSSProperties = canAdmin ? {} : { pointerEvents: 'none', opacity: 0.55 }

  const renameStage = (index: number): void => {
    const from = settings.stages[index]!
    const to = (stageDrafts[index] ?? from).trim()
    setStageDrafts((d) => { const next = { ...d }; delete next[index]; return next })
    if (!to || to === from) return
    void desk.saveSettings({ stageRenames: [{ from, to }] })
  }
  const moveStage = (index: number, dir: -1 | 1): void => {
    const j = index + dir
    if (j < 0 || j >= settings.stages.length) return
    const stages = [...settings.stages]
    const tmp = stages[index]!
    stages[index] = stages[j]!
    stages[j] = tmp
    void desk.saveSettings({ stages })
  }
  const toggleClosed = (stage: string): void => {
    if (stage === settings.wonStage || stage === settings.lostStage) {
      desk.toast('The won and lost stages must stay closed.')
      return
    }
    const cur = settings.closedStages
    void desk.saveSettings({ closedStages: cur.includes(stage) ? cur.filter((s) => s !== stage) : [...cur, stage] })
  }
  const setWonLost = (key: 'wonStage' | 'lostStage', value: string): void => {
    const closedStages = settings.closedStages.includes(value) ? settings.closedStages : [...settings.closedStages, value]
    void desk.saveSettings({ [key]: value, closedStages })
  }

  return (
    <div style={{ padding: 'clamp(16px,2.4vw,26px) clamp(16px,3vw,28px)', maxWidth: 940, margin: '0 auto', animation: 'll-fade .3s ease' }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontFamily: serif, fontSize: 23, fontWeight: 600 }}>Settings</div>
        <div style={{ fontSize: 12.5, color: C.sub, marginTop: 2 }}>
          {canAdmin ? 'Configure how your leads connect and how the AI scores them. Changes save instantly.' : 'You have member access — settings are read-only. Ask an admin to make changes.'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', background: C.bg4, borderRadius: 11, padding: 5, marginBottom: 22, width: 'fit-content', maxWidth: '100%' }}>
        {tabs.map(([id, label]) => (
          <div
            key={id}
            onClick={() => set({ settingsTab: id })}
            style={{ padding: '8px 14px', fontSize: 13, fontWeight: activeTab === id ? 600 : 500, cursor: 'pointer', borderRadius: 8, whiteSpace: 'nowrap', background: activeTab === id ? '#fff' : 'transparent', color: activeTab === id ? A : C.sub, boxShadow: activeTab === id ? '0 1px 2px rgba(26,26,26,.06)' : 'none' }}
          >
            {label}
          </div>
        ))}
      </div>

      {activeTab === 'connection' && canAdmin && <ConnectionTab />}

      {activeTab === 'ai' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, ...gated }}>
          <div style={card}>
            <div style={sectionTitle}>Inquiry categories</div>
            <div style={sectionDesc}>The set of categories the AI sorts each lead into. These drive the Type column and filters.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 12, maxWidth: 420 }}>
              {settings.inquiryTypes.map((t) => (
                <div key={t} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.bg3, borderRadius: 7, padding: '7px 8px 7px 12px' }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{t}</span>
                  <button onClick={() => void desk.saveSettings({ inquiryTypes: settings.inquiryTypes.filter((x) => x !== t) })} style={linkDanger}>Remove</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, maxWidth: 420 }}>
              <input value={newType} onChange={(e) => setNewType(e.target.value)} placeholder="Add a category..." style={{ ...inputS, flex: 1 }} />
              <button
                onClick={() => { const v = newType.trim(); if (v && !settings.inquiryTypes.includes(v)) void desk.saveSettings({ inquiryTypes: [...settings.inquiryTypes, v] }); setNewType('') }}
                style={btnSmall}
              >
                Add
              </button>
            </div>
          </div>
          <div style={card}>
            <div style={sectionTitle}>Tier cutoffs</div>
            <div style={sectionDesc}>
              Where hot / warm / cold fall on the 0–10 AI lead score. Saving recomputes the tier on every lead and re-colors it across every view.
            </div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <div>
                <div style={{ ...upLabel, letterSpacing: '.05em', marginBottom: 7 }}>Hot when lead score ≥</div>
                <NumField value={settings.tierThresholds.hot} min={0} max={10} onCommit={(hot) => void desk.saveSettings({ tierThresholds: { hot, warm: Math.min(settings.tierThresholds.warm, hot) } })} />
              </div>
              <div>
                <div style={{ ...upLabel, letterSpacing: '.05em', marginBottom: 7 }}>Warm when ≥</div>
                <NumField value={settings.tierThresholds.warm} min={0} max={10} onCommit={(warm) => void desk.saveSettings({ tierThresholds: { hot: Math.max(settings.tierThresholds.hot, warm), warm } })} />
              </div>
            </div>
          </div>
          <div style={card}>
            <div style={sectionTitle}>Win-probability mapping</div>
            <div style={sectionDesc}>
              Default likelihood by lead score — multiplied by the deal midpoint to produce each lead&apos;s expected value. Saving recomputes every lead; a probability someone set by hand on a lead is kept.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 }}>
              {bandLabels(settings.winProbabilityMap).map(({ band, label }) => (
                <div key={band.min} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <span style={{ fontFamily: mono, fontSize: 13, width: 52, color: C.body }}>{label}</span>
                  <NumField
                    value={Math.round(band.p * 100)}
                    min={0}
                    max={100}
                    onCommit={(pct) =>
                      void desk.saveSettings({
                        winProbabilityMap: settings.winProbabilityMap.map((b) => (b.min === band.min ? { min: b.min, p: pct / 100 } : b)),
                      })
                    }
                  />
                  <span style={{ color: C.faint, fontSize: 13 }}>% win probability</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'pipeline' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, ...gated }}>
          <div style={card}>
            <div style={sectionTitle}>Pipeline stages</div>
            <div style={sectionDesc}>
              Rename or reorder the stages a lead moves through. Renames carry every existing lead along; the pipeline board and every stage dropdown follow this order.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 460 }}>
              {settings.stages.map((stage, i) => (
                <div key={`${stage}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    value={stageDrafts[i] ?? stage}
                    onChange={(e) => setStageDrafts((d) => ({ ...d, [i]: e.target.value }))}
                    onBlur={() => renameStage(i)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    style={{ ...inputS, flex: 1, padding: '7px 10px' }}
                  />
                  <button onClick={() => moveStage(i, -1)} style={{ width: 30, height: 30, border: `1px solid ${C.border2}`, background: '#fff', borderRadius: 7, cursor: 'pointer', color: C.sub, flex: '0 0 auto' }}>↑</button>
                  <button onClick={() => moveStage(i, 1)} style={{ width: 30, height: 30, border: `1px solid ${C.border2}`, background: '#fff', borderRadius: 7, cursor: 'pointer', color: C.sub, flex: '0 0 auto' }}>↓</button>
                </div>
              ))}
            </div>
          </div>
          <div style={card}>
            <div style={sectionTitle}>Stage semantics</div>
            <div style={sectionDesc}>
              Which stages count as closed, and which mark a deal won or lost. Closed stages leave the pipeline and stop overdue tracking; won and lost drive win-rate analytics.
            </div>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 18 }}>
              {(['wonStage', 'lostStage'] as const).map((key) => (
                <div key={key}>
                  <div style={{ ...upLabel, letterSpacing: '.05em', marginBottom: 7 }}>{key === 'wonStage' ? 'Won stage' : 'Lost stage'}</div>
                  <select value={settings[key]} onChange={(e) => setWonLost(key, e.target.value)} style={{ ...inputS, padding: '8px 9px' }}>
                    {settings.stages.map((s) => (<option key={s} value={s}>{s}</option>))}
                  </select>
                </div>
              ))}
            </div>
            <div style={{ ...upLabel, letterSpacing: '.05em', marginBottom: 7 }}>Closed stages</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {settings.stages.map((stage) => (
                <label key={stage} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, border: `1px solid ${C.border2}`, borderRadius: 999, padding: '6px 12px', cursor: 'pointer', background: '#fff' }}>
                  <input type="checkbox" checked={settings.closedStages.includes(stage)} onChange={() => toggleClosed(stage)} />
                  {stage}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'team' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={card}>
            <div style={sectionTitle}>Team</div>
            <div style={sectionDesc}>
              Everyone who can sign in and be assigned leads. Members work leads; admins also manage credentials, invites, and these settings.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 16, maxWidth: 560 }}>
              {st.users.map((u) => (
                <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: C.bg3, borderRadius: 8, padding: '9px 12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{u.name}</span>
                  <span style={{ fontSize: 12, color: C.sub, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.email}</span>
                  <span style={{ fontSize: 11.5, color: C.faint }}>{u.lastLoginAt ? `Active ${fmtDate(u.lastLoginAt)}` : 'Invite pending'}</span>
                  {u.developer && (
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: '#fff', background: A, borderRadius: 5, padding: '3px 7px', textTransform: 'uppercase' }}>
                      Developer
                    </span>
                  )}
                  <span style={rolePill(u.role)}>{u.role}</span>
                </div>
              ))}
            </div>
            {st.inviteResult && (
              <div style={{ background: 'rgba(18,67,59,.06)', border: '1px solid rgba(18,67,59,.25)', borderRadius: 10, padding: '13px 15px', marginBottom: 14, maxWidth: 560 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: A }}>
                  Invite created for {st.inviteResult.email} ({st.inviteResult.role})
                </div>
                <div style={{ fontFamily: mono, fontSize: 12, background: '#fff', border: `1px solid ${C.border2}`, borderRadius: 7, padding: '8px 10px', marginTop: 8, wordBreak: 'break-all' }}>
                  {st.inviteResult.url}
                </div>
                <div style={{ fontSize: 11.5, color: C.sub, marginTop: 7 }}>Share this link — it expires in 7 days. They set a name and password on accept.</div>
                <button onClick={() => set({ inviteResult: null })} style={{ background: 'none', border: 'none', color: A, cursor: 'pointer', fontSize: 12, fontWeight: 600, marginTop: 6, padding: 0 }}>Done</button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, maxWidth: 560, flexWrap: 'wrap', ...gated }}>
              <input value={invEmail} onChange={(e) => setInvEmail(e.target.value)} placeholder="colleague@yourbusiness.com" style={{ ...inputS, flex: 1, minWidth: 200 }} />
              <select value={invRole} onChange={(e) => setInvRole(e.target.value as Role)} style={{ ...inputS, padding: '8px 9px' }}>
                <option value="MEMBER">Member</option>
                <option value="ADMIN">Admin</option>
              </select>
              <button onClick={() => { if (invEmail.trim()) { void desk.invite(invEmail.trim(), invRole); setInvEmail('') } }} style={btnSmall}>
                Send invite
              </button>
            </div>
          </div>
          <div style={{ ...card, ...gated }}>
            <div style={sectionTitle}>Lead sources</div>
            <div style={sectionDesc}>The inbound channels a lead can arrive through.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 12, maxWidth: 420 }}>
              {settings.sources.map((s) => (
                <div key={s} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.bg3, borderRadius: 7, padding: '7px 8px 7px 12px' }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{s}</span>
                  <button onClick={() => void desk.saveSettings({ sources: settings.sources.filter((x) => x !== s) })} style={linkDanger}>Remove</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, maxWidth: 420 }}>
              <input value={newSource} onChange={(e) => setNewSource(e.target.value)} placeholder="Add source..." style={{ ...inputS, flex: 1 }} />
              <button
                onClick={() => { const v = newSource.trim(); if (v && !settings.sources.includes(v)) void desk.saveSettings({ sources: [...settings.sources, v] }); setNewSource('') }}
                style={btnSmall}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'notifications' && (
        <div style={{ ...card, ...gated }}>
          <div style={sectionTitle}>Notifications &amp; attention</div>
          <div style={sectionDesc}>
            What Leadline surfaces as needing attention on Today and in the lead queue. Overdue follow-ups and recent unassigned leads are always flagged.
          </div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div>
              <div style={{ ...upLabel, letterSpacing: '.05em', marginBottom: 7 }}>Flag hot when lead score ≥</div>
              <NumField value={settings.notificationThresholds.hotLeadScore} min={0} max={10} onCommit={(v) => void desk.saveSettings({ notificationThresholds: { hotLeadScore: v } })} />
            </div>
            <div>
              <div style={{ ...upLabel, letterSpacing: '.05em', marginBottom: 7 }}>Mark stale after (days)</div>
              <NumField value={settings.staleDays} min={1} max={90} onCommit={(v) => void desk.saveSettings({ staleDays: v })} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
