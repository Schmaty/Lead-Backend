import type { CSSProperties, ReactNode } from 'react'
import { fmtDateShort, relDays, urgColor, usd, type LeadView } from '../compute'
import { useFiltered, useOwnerOpts, useSorted, useViews } from '../hooks'
import { IColumns, IDownload } from '../icons'
import { useDesk } from '../store'
import { C, chipStyle, mono, seg, serif, tierChip } from '../styles'
import { defaultFilters, type ColumnKey, type SortCol } from '../types'

const COL_DEFS: Array<{ key: ColumnKey; label: string; width?: number; flex?: string; right?: boolean }> = [
  { key: 'received', label: 'Received', width: 92 },
  { key: 'name', label: 'Name', flex: '1.4 1 150px' },
  { key: 'org', label: 'Org', flex: '1.1 1 120px' },
  { key: 'type', label: 'Type', width: 150 },
  { key: 'tier', label: 'Tier', width: 80 },
  { key: 'fit', label: 'Fit', width: 46, right: true },
  { key: 'urgency', label: 'Urg', width: 46, right: true },
  { key: 'lead', label: 'Lead', width: 56, right: true },
  { key: 'ev', label: 'Expected', width: 98, right: true },
  { key: 'stage', label: 'Stage', width: 154 },
  { key: 'owner', label: 'Owner', width: 128 },
  { key: 'follow_up', label: 'Follow-up', width: 104 },
  { key: 'last', label: 'Last touch', width: 96 },
]

const CSV_COLS = [
  'receivedAt', 'name', 'org', 'email', 'source', 'inquiryType', 'fitScore', 'urgencyScore', 'leadScore',
  'tier', 'dealValueLow', 'dealValueHigh', 'winProbability', 'expectedValue', 'stage', 'owner',
  'followUpDate', 'replySent', 'lastTouchedAt',
] as const

function exportCsv(rows: LeadView[]): number {
  const esc = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = rows.map((l) =>
    CSV_COLS.map((c) => {
      if (c === 'owner') return esc(l.ownerName ?? '')
      if (c === 'expectedValue') return esc(Math.round(l.ev))
      if (c === 'winProbability') return esc(l.prob)
      return esc(l[c as keyof LeadView])
    }).join(','),
  )
  const csv = [CSV_COLS.join(','), ...lines].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'leadline-leads.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return rows.length
}

const cellPad: CSSProperties = { padding: '0 10px' }
const colWidth = (def: (typeof COL_DEFS)[number]): CSSProperties =>
  def.flex ? { flex: def.flex, minWidth: 0 } : { width: def.width, flex: `0 0 ${def.width}px` }

export default function Leads(): ReactNode {
  const desk = useDesk()
  const { st, set } = desk
  const settings = st.settings!
  const views = useViews()
  const filtered = useFiltered(views)
  const sorted = useSorted(filtered)
  const { names: ownerNames, idFor } = useOwnerOpts()

  const rowH = st.density === 'compact' ? 40 : 52
  const allIds = sorted.map((l) => l.id)
  const allSelected = allIds.length > 0 && st.selection.length === allIds.length

  const setSort = (col: SortCol): void =>
    set((s) => ({ sort: { col, dir: s.sort.col === col && s.sort.dir === 'asc' ? 'desc' : 'asc' } }))
  const arrow = (col: SortCol): string => (st.sort.col === col ? (st.sort.dir === 'asc' ? '  ↑' : '  ↓') : '')

  const selectStyle: CSSProperties = { width: '100%', padding: '5px 6px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, background: '#fff', color: C.text }
  const bulkSelect: CSSProperties = { background: 'rgba(255,255,255,.14)', color: '#fff', border: '1px solid rgba(255,255,255,.25)', borderRadius: 7, padding: '6px 9px', fontSize: 12.5 }

  const patchOwner = (leadId: string, value: string): void => {
    void desk.updateLead(leadId, { ownerId: value === 'Unassigned' ? null : idFor(value) })
  }

  return (
    <div style={{ padding: 'clamp(16px,2.4vw,26px) clamp(16px,3vw,28px)', animation: 'll-fade .3s ease' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: serif, fontSize: 23, fontWeight: 600 }}>All Leads</div>
          <div style={{ fontSize: 12.5, color: C.sub, marginTop: 2 }}>
            <span style={{ fontFamily: mono }}>{sorted.length}</span> of {views.length} leads
          </div>
        </div>
        <div data-ll-menu style={{ display: 'flex', alignItems: 'center', gap: 9, position: 'relative' }}>
          <div style={{ display: 'flex', border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'hidden' }}>
            <button onClick={() => set({ density: 'comfortable' })} style={seg(st.density !== 'compact')}>Comfortable</button>
            <button onClick={() => set({ density: 'compact' })} style={seg(st.density === 'compact')}>Compact</button>
          </div>
          <button
            onClick={() => set((s) => ({ colMenuOpen: !s.colMenuOpen }))}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: `1px solid ${C.border2}`, borderRadius: 8, padding: '8px 12px', fontSize: 12.5, fontWeight: 500, cursor: 'pointer', color: C.text }}
          >
            <IColumns size={14} strokeWidth={1.8} />
            Columns
          </button>
          {st.colMenuOpen && (
            <div style={{ position: 'absolute', right: 96, top: 44, background: '#fff', border: `1px solid ${C.border2}`, borderRadius: 10, boxShadow: '0 10px 28px rgba(26,26,26,.14)', padding: 8, zIndex: 50, minWidth: 170 }}>
              {COL_DEFS.map((def) => (
                <label key={def.key} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 8px', fontSize: 12.5, cursor: 'pointer', borderRadius: 6 }}>
                  <input
                    type="checkbox"
                    checked={st.columns[def.key]}
                    onChange={() => set((s) => ({ columns: { ...s.columns, [def.key]: !s.columns[def.key] } }))}
                  />
                  {def.label}
                </label>
              ))}
            </div>
          )}
          <button
            className="hv-ghost"
            onClick={() => { const n = exportCsv(sorted); desk.toast(`Exported ${n} leads to CSV`) }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #12433B', color: '#12433B', borderRadius: 8, padding: '8px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
          >
            <IDownload size={14} strokeWidth={1.8} />
            Export CSV
          </button>
        </div>
      </div>

      {st.selection.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: '#12433B', color: '#fff', borderRadius: 10, padding: '9px 14px', marginBottom: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{st.selection.length} selected</span>
          <select
            value=""
            onChange={(e) => { if (e.target.value) void desk.bulk(st.selection, { stage: e.target.value }, 'Set stage') }}
            style={bulkSelect}
          >
            <option value="">Set stage…</option>
            {settings.stages.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
          <select
            value=""
            onChange={(e) => {
              if (!e.target.value) return
              void desk.bulk(st.selection, { ownerId: e.target.value === 'Unassigned' ? null : idFor(e.target.value) }, 'Assigned')
            }}
            style={bulkSelect}
          >
            <option value="">Assign owner…</option>
            {ownerNames.map((o) => (<option key={o} value={o}>{o}</option>))}
          </select>
          <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 7 }}>
            Follow-up
            <input
              type="date"
              onChange={(e) => { if (e.target.value) void desk.bulk(st.selection, { followUpDate: e.target.value }, 'Set follow-up') }}
              style={{ ...bulkSelect, padding: '5px 8px', fontSize: 12, colorScheme: 'dark' }}
            />
          </label>
          <div style={{ flex: 1 }} />
          <button onClick={() => set({ selection: [] })} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,.3)', color: '#fff', borderRadius: 7, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
            Clear
          </button>
        </div>
      )}

      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 2px rgba(26,26,26,.04)' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 1120 }}>
            <div style={{ display: 'flex', alignItems: 'center', background: C.bg2, borderBottom: `1px solid ${C.border}` }}>
              <div style={{ width: 38, flex: '0 0 38px', display: 'flex', justifyContent: 'center', padding: '11px 0' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => set((s) => ({ selection: allSelected ? [] : [...allIds] }))}
                />
              </div>
              {COL_DEFS.filter((d) => st.columns[d.key]).map((def) => (
                <div
                  key={def.key}
                  onClick={() => setSort(def.key)}
                  style={{ ...colWidth(def), ...cellPad, padding: '11px 10px', fontSize: 11.5, fontWeight: 600, color: C.sub, cursor: 'pointer', whiteSpace: 'nowrap', ...(def.right ? { textAlign: 'right' } : {}) }}
                >
                  {def.label}
                  {arrow(def.key)}
                </div>
              ))}
            </div>
            {sorted.length > 0 ? (
              sorted.map((l) => {
                const chip = tierChip(l.tier)
                const selected = st.selection.includes(l.id)
                return (
                  <div
                    key={l.id}
                    onClick={() => set({ detailId: l.id })}
                    style={{ display: 'flex', alignItems: 'center', minHeight: rowH, borderBottom: `1px solid ${C.line}`, background: selected ? 'rgba(18,67,59,.05)' : l.overdue ? 'rgba(180,35,24,.03)' : '#fff', cursor: 'pointer' }}
                  >
                    <div style={{ width: 38, flex: '0 0 38px', display: 'flex', justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => set((s) => ({ selection: selected ? s.selection.filter((x) => x !== l.id) : [...s.selection, l.id] }))}
                      />
                    </div>
                    {st.columns.received && (
                      <div style={{ ...colWidth(COL_DEFS[0]!), ...cellPad, fontFamily: mono, fontSize: 11.5, color: C.sub, whiteSpace: 'nowrap', overflow: 'hidden' }}>{fmtDateShort(l.receivedAt)}</div>
                    )}
                    {st.columns.name && (
                      <div style={{ ...colWidth(COL_DEFS[1]!), ...cellPad, fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name}</div>
                    )}
                    {st.columns.org && (
                      <div style={{ ...colWidth(COL_DEFS[2]!), ...cellPad, color: C.body, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.org || '—'}</div>
                    )}
                    {st.columns.type && (
                      <div style={{ ...colWidth(COL_DEFS[3]!), ...cellPad, color: C.sub, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.inquiryType}</div>
                    )}
                    {st.columns.tier && (
                      <div style={{ ...colWidth(COL_DEFS[4]!), ...cellPad }}><span style={chipStyle(l.tier)}>{chip.label}</span></div>
                    )}
                    {st.columns.fit && (
                      <div style={{ ...colWidth(COL_DEFS[5]!), ...cellPad, fontFamily: mono, fontSize: 12.5, textAlign: 'right', color: C.body }}>{l.fitScore}</div>
                    )}
                    {st.columns.urgency && (
                      <div style={{ ...colWidth(COL_DEFS[6]!), ...cellPad, fontFamily: mono, fontSize: 12.5, textAlign: 'right', color: C.body }}>{l.urgencyScore}</div>
                    )}
                    {st.columns.lead && (
                      <div style={{ ...colWidth(COL_DEFS[7]!), ...cellPad, textAlign: 'right' }}>
                        <span style={{ fontFamily: mono, fontWeight: 600, color: chip.fg, fontSize: 13 }}>{l.leadScore}</span>
                      </div>
                    )}
                    {st.columns.ev && (
                      <div style={{ ...colWidth(COL_DEFS[8]!), ...cellPad, fontFamily: mono, fontSize: 12.5, textAlign: 'right', fontWeight: 500 }}>{usd(l.ev)}</div>
                    )}
                    {st.columns.stage && (
                      <div style={{ ...colWidth(COL_DEFS[9]!), padding: '0 8px' }} onClick={(e) => e.stopPropagation()}>
                        <select value={l.stage} onChange={(e) => void desk.updateLead(l.id, { stage: e.target.value })} style={selectStyle}>
                          {settings.stages.map((s) => (<option key={s} value={s}>{s}</option>))}
                        </select>
                      </div>
                    )}
                    {st.columns.owner && (
                      <div style={{ ...colWidth(COL_DEFS[10]!), padding: '0 8px' }} onClick={(e) => e.stopPropagation()}>
                        <select value={l.ownerName ?? 'Unassigned'} onChange={(e) => patchOwner(l.id, e.target.value)} style={selectStyle}>
                          {ownerNames.map((o) => (<option key={o} value={o}>{o}</option>))}
                        </select>
                      </div>
                    )}
                    {st.columns.follow_up && (
                      <div style={{ ...colWidth(COL_DEFS[11]!), ...cellPad, fontFamily: mono, fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                        <span style={l.overdue ? { color: C.danger, fontWeight: 600 } : { color: C.sub }}>
                          {l.followUpDate ? fmtDateShort(l.followUpDate) : '—'}
                        </span>
                      </div>
                    )}
                    {st.columns.last && (
                      <div style={{ ...colWidth(COL_DEFS[12]!), ...cellPad, fontSize: 11.5, color: C.faint, whiteSpace: 'nowrap', overflow: 'hidden' }}>{relDays(l.lastTouch, st.now)}</div>
                    )}
                  </div>
                )
              })
            ) : (
              <div style={{ padding: '46px 20px', textAlign: 'center', color: C.sub, fontSize: 14 }}>
                No leads match these filters.{' '}
                <span
                  onClick={() => set({ filters: defaultFilters(), search: '' })}
                  style={{ color: '#12433B', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Clear them?
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
