import type { CSSProperties, ReactNode } from 'react'
import { cap, isoDate, usd } from '../compute'
import { useFiltered, useOwnerOpts, useViews } from '../hooks'
import { IFilter } from '../icons'
import { useDesk } from '../store'
import { C, mono, tgl, upLabel } from '../styles'
import { defaultFilters, type Filters } from '../types'

const numIn: CSSProperties = {
  width: 52, padding: '6px 8px', border: `1px solid ${C.border2}`, borderRadius: 7, fontSize: 12.5, fontFamily: mono,
}
const dateIn: CSSProperties = { padding: '6px 8px', border: `1px solid ${C.border2}`, borderRadius: 7, fontSize: 12 }

export default function FilterBar(): ReactNode {
  const desk = useDesk()
  const { st, set } = desk
  const settings = st.settings!
  const views = useViews()
  const filtered = useFiltered(views)
  const { names: ownerNames } = useOwnerOpts()
  const f = st.filters

  const setFilter = <K extends keyof Filters>(field: K, value: Filters[K]): void => {
    set((s) => ({ filters: { ...s.filters, [field]: value } }))
    setTimeout(() => desk.pushFilterHash(), 0)
  }
  const toggleMulti = (field: 'stages' | 'tiers' | 'types' | 'sources' | 'owners', value: string) => () => {
    const arr = f[field]
    setFilter(field, arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value])
  }
  const clearAll = (): void => {
    set({ filters: defaultFilters(), search: '' })
    setTimeout(() => desk.pushFilterHash(defaultFilters(), ''), 0)
  }

  const openStages = settings.stages.filter((s) => !settings.closedStages.includes(s))
  const preset = (name: string) => (): void => {
    const next = defaultFilters()
    if (name === 'hotopen') { next.tiers = ['hot']; next.stages = [...openStages] }
    else if (name === 'overdue') next.overdueOnly = true
    else if (name === 'unassigned') { next.owners = ['Unassigned']; next.stages = [...openStages] }
    else if (name === 'newtoday') next.recvFrom = isoDate(st.now)
    else if (name === 'won') next.stages = [settings.wonStage]
    set({ filters: next, search: '' })
    setTimeout(() => desk.pushFilterHash(next, ''), 0)
  }

  const chips: Array<{ label: string; clear: () => void }> = []
  const push = (label: string, clear: () => void): void => { chips.push({ label, clear }) }
  if (f.stages.length) push(`Stage · ${f.stages.length}`, () => setFilter('stages', []))
  if (f.tiers.length) push(`Tier · ${f.tiers.map(cap).join(', ')}`, () => setFilter('tiers', []))
  if (f.types.length) push(`Type · ${f.types.length}`, () => setFilter('types', []))
  if (f.sources.length) push(`Source · ${f.sources.length}`, () => setFilter('sources', []))
  if (f.owners.length) push(`Owner · ${f.owners.join(', ')}`, () => setFilter('owners', []))
  if (f.fitMin !== 0 || f.fitMax !== 10) push(`Fit ${f.fitMin}–${f.fitMax}`, () => { setFilter('fitMin', 0); setFilter('fitMax', 10) })
  if (f.urgMin !== 0 || f.urgMax !== 10) push(`Urgency ${f.urgMin}–${f.urgMax}`, () => { setFilter('urgMin', 0); setFilter('urgMax', 10) })
  if (f.leadMin !== 0 || f.leadMax !== 10) push(`Lead ${f.leadMin}–${f.leadMax}`, () => { setFilter('leadMin', 0); setFilter('leadMax', 10) })
  if (f.evMin !== '' || f.evMax !== '') {
    push(`EV ${f.evMin !== '' ? usd(Number(f.evMin)) : '$0'}–${f.evMax !== '' ? usd(Number(f.evMax)) : '∞'}`, () => { setFilter('evMin', ''); setFilter('evMax', '') })
  }
  if (f.recvFrom || f.recvTo) push('Received range', () => { setFilter('recvFrom', ''); setFilter('recvTo', '') })
  if (f.followFrom || f.followTo) push('Follow-up range', () => { setFilter('followFrom', ''); setFilter('followTo', '') })
  if (f.overdueOnly) push('Overdue only', () => setFilter('overdueOnly', false))
  if (f.replySent !== 'any') push(`Reply · ${f.replySent}`, () => setFilter('replySent', 'any'))
  if (f.needsAttention) push('Needs attention', () => setFilter('needsAttention', false))

  const optRow = (
    title: string,
    options: string[],
    field: 'stages' | 'tiers' | 'types' | 'sources' | 'owners',
    labelFn: (v: string) => string = (v) => v,
    maxWidth?: number,
  ): ReactNode => (
    <div style={{ minWidth: 120 }}>
      <div style={upLabel}>{title}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', ...(maxWidth ? { maxWidth } : {}) }}>
        {options.map((o) => (
          <span key={o} onClick={toggleMulti(field, o)} style={tgl(f[field].includes(o))}>
            {labelFn(o)}
          </span>
        ))}
      </div>
    </div>
  )

  const range = (
    label: string,
    minField: 'fitMin' | 'urgMin' | 'leadMin',
    maxField: 'fitMax' | 'urgMax' | 'leadMax',
  ): ReactNode => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, color: C.sub, width: 56 }}>{label}</span>
      <input type="number" min={0} max={10} value={f[minField]} onChange={(e) => setFilter(minField, Number(e.target.value))} style={numIn} />
      <span style={{ color: C.faint }}>–</span>
      <input type="number" min={0} max={10} value={f[maxField]} onChange={(e) => setFilter(maxField, Number(e.target.value))} style={numIn} />
    </div>
  )

  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, background: C.bg2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px clamp(16px,3vw,28px)', flexWrap: 'wrap' }}>
        <button
          onClick={() => set((s) => ({ filtersOpen: !s.filtersOpen }))}
          style={{ display: 'flex', alignItems: 'center', gap: 7, background: '#fff', border: `1px solid ${C.border2}`, borderRadius: 8, padding: '7px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: C.text, flex: '0 0 auto' }}
        >
          <IFilter size={15} strokeWidth={1.8} />
          Filters
        </button>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
          {[
            ['hotopen', 'Hot & open'],
            ['overdue', 'Overdue'],
            ['unassigned', 'Unassigned'],
            ['newtoday', 'New today'],
            ['won', settings.wonStage],
          ].map(([key, label]) => (
            <button key={key} className="hv-accent" onClick={preset(key!)} style={{ background: '#fff', border: `1px solid ${C.border2}`, borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 500, cursor: 'pointer', color: C.body, whiteSpace: 'nowrap' }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ fontFamily: mono, fontSize: 12.5, color: C.sub, flex: '0 0 auto' }}>
          {filtered.length} / {views.length}
        </div>
        {chips.length > 0 && (
          <button onClick={clearAll} style={{ background: 'transparent', border: 'none', color: C.danger, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', flex: '0 0 auto' }}>
            Clear all
          </button>
        )}
      </div>
      {chips.length > 0 && (
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', padding: '0 clamp(16px,3vw,28px) 11px' }}>
          {chips.map((c) => (
            <span key={c.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(18,67,59,.07)', color: '#12433B', borderRadius: 999, padding: '4px 6px 4px 11px', fontSize: 12, fontWeight: 500 }}>
              {c.label}
              <span onClick={c.clear} style={{ cursor: 'pointer', width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, background: 'rgba(18,67,59,.12)', fontSize: 12, lineHeight: 1 }}>
                ×
              </span>
            </span>
          ))}
        </div>
      )}
      {st.filtersOpen && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: '16px clamp(16px,3vw,28px)', display: 'flex', flexWrap: 'wrap', gap: '22px 30px', background: '#fff' }}>
          {optRow('Stage', settings.stages, 'stages', (v) => v, 340)}
          {optRow('Tier', ['hot', 'warm', 'cold'], 'tiers', cap)}
          {optRow('Owner', ownerNames, 'owners')}
          {optRow('Source', settings.sources, 'sources', (v) => v, 280)}
          <div style={{ minWidth: 240, flex: 1, maxWidth: 360 }}>
            <div style={upLabel}>Inquiry type</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {settings.inquiryTypes.map((o) => (
                <span key={o} onClick={toggleMulti('types', o)} style={tgl(f.types.includes(o))}>{o}</span>
              ))}
            </div>
          </div>
          <div>
            <div style={upLabel}>Scores (min–max)</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {range('Fit', 'fitMin', 'fitMax')}
              {range('Urgency', 'urgMin', 'urgMax')}
              {range('Lead', 'leadMin', 'leadMax')}
            </div>
          </div>
          <div>
            <div style={upLabel}>Expected value ($)</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="number" min={0} placeholder="min" value={f.evMin} onChange={(e) => setFilter('evMin', e.target.value)} style={{ ...numIn, width: 82 }} />
              <span style={{ color: C.faint }}>–</span>
              <input type="number" min={0} placeholder="max" value={f.evMax} onChange={(e) => setFilter('evMax', e.target.value)} style={{ ...numIn, width: 82 }} />
            </div>
          </div>
          <div>
            <div style={upLabel}>Received</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="date" value={f.recvFrom} onChange={(e) => setFilter('recvFrom', e.target.value)} style={dateIn} />
              <span style={{ color: C.faint }}>→</span>
              <input type="date" value={f.recvTo} onChange={(e) => setFilter('recvTo', e.target.value)} style={dateIn} />
            </div>
          </div>
          <div>
            <div style={upLabel}>Follow-up</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <input type="date" value={f.followFrom} onChange={(e) => setFilter('followFrom', e.target.value)} style={dateIn} />
              <span style={{ color: C.faint }}>→</span>
              <input type="date" value={f.followTo} onChange={(e) => setFilter('followTo', e.target.value)} style={dateIn} />
              <span onClick={() => setFilter('overdueOnly', !f.overdueOnly)} style={tgl(f.overdueOnly)}>Overdue</span>
            </div>
          </div>
          <div>
            <div style={upLabel}>Reply &amp; attention</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <select value={f.replySent} onChange={(e) => setFilter('replySent', e.target.value as Filters['replySent'])} style={{ padding: '7px 9px', border: `1px solid ${C.border2}`, borderRadius: 7, fontSize: 12.5, background: '#fff' }}>
                <option value="any">Reply · any</option>
                <option value="yes">Replied</option>
                <option value="no">Not replied</option>
              </select>
              <span onClick={() => setFilter('needsAttention', !f.needsAttention)} style={tgl(f.needsAttention)}>Needs attention</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
