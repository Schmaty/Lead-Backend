import type { CSSProperties } from 'react'
import { cap } from './compute'

/** Design tokens from the Lead Desk brief. */
export const A = '#12433B'
export const A_DARK = '#0d322c'
export const C = {
  text: '#1A1A1A',
  body: '#4A4A44',
  sub: '#6B6B63',
  faint: '#9a9a92',
  ghost: '#B5B5AC',
  border: '#E7E7E1',
  border2: '#E2E2DB',
  line: '#EFEFE9',
  bg: '#FAFAF7',
  bg2: '#FCFCFA',
  bg3: '#F7F7F2',
  bg4: '#F1F1EB',
  danger: '#B42318',
  warn: '#B54708',
  ok: '#1F8A5B',
  gold: '#C99A2E',
}
export const mono = "'JetBrains Mono',ui-monospace,monospace"
export const serif = "'Fraunces',Georgia,serif"

export const card: CSSProperties = {
  background: '#fff',
  border: `1px solid ${C.border}`,
  borderRadius: 14,
  padding: '20px 22px',
  boxShadow: '0 1px 2px rgba(26,26,26,.04)',
}

export const cardTight: CSSProperties = { ...card, borderRadius: 12, padding: '16px 18px' }

/** Uppercase section micro-label. */
export const upLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: '#8A8A80',
  marginBottom: 9,
}

export const inputS: CSSProperties = {
  padding: '8px 10px',
  border: `1px solid ${C.border2}`,
  borderRadius: 7,
  fontSize: 13,
  background: '#fff',
  outline: 'none',
}

export const inputMono: CSSProperties = { ...inputS, fontFamily: mono, fontSize: 12.5 }

export const btnPrimary: CSSProperties = {
  background: A,
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '9px 15px',
  fontSize: 13.5,
  fontWeight: 600,
  cursor: 'pointer',
}

export const btnSmall: CSSProperties = { ...btnPrimary, borderRadius: 7, padding: '8px 14px', fontSize: 13 }

export const btnGhost: CSSProperties = {
  background: '#fff',
  border: `1px solid ${C.border2}`,
  borderRadius: 8,
  padding: '8px 13px',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
  color: C.text,
}

export const linkDanger: CSSProperties = {
  background: 'none',
  border: 'none',
  color: C.danger,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
}

export function navStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '9px 12px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: active ? 600 : 500,
    color: active ? A : C.sub,
    background: active ? 'rgba(18,67,59,.07)' : 'transparent',
    transition: 'background .15s,color .15s',
    userSelect: 'none',
  }
}

export function tierChip(t: string): { fg: string; bg: string; label: string } {
  const map: Record<string, [string, string]> = {
    hot: ['#B42318', 'rgba(180,35,24,.08)'],
    warm: ['#B54708', 'rgba(181,71,8,.10)'],
    cold: ['#667085', 'rgba(102,112,133,.11)'],
  }
  const pair = map[t] ?? map.cold!
  return { fg: pair[0], bg: pair[1], label: cap(t) }
}

export function chipStyle(t: string): CSSProperties {
  const c = tierChip(t)
  return {
    color: c.fg,
    background: c.bg,
    padding: '2px 9px',
    borderRadius: 999,
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    display: 'inline-block',
    lineHeight: 1.5,
    whiteSpace: 'nowrap',
  }
}

/** Pill toggle used in the filter panel. */
export function tgl(active: boolean): CSSProperties {
  return active
    ? {
        padding: '5px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        border: `1px solid ${A}`, background: 'rgba(18,67,59,.08)', color: A, whiteSpace: 'nowrap', userSelect: 'none',
      }
    : {
        padding: '5px 11px', borderRadius: 999, fontSize: 12, fontWeight: 500, cursor: 'pointer',
        border: `1px solid ${C.border2}`, background: '#fff', color: C.body, whiteSpace: 'nowrap', userSelect: 'none',
      }
}

/** Segmented-control button. */
export function seg(active: boolean): CSSProperties {
  return {
    padding: '7px 13px',
    fontSize: 12.5,
    fontWeight: active ? 600 : 500,
    cursor: 'pointer',
    border: 'none',
    background: active ? 'rgba(18,67,59,.09)' : '#fff',
    color: active ? A : C.sub,
    whiteSpace: 'nowrap',
  }
}

export function rolePill(role: string): CSSProperties {
  return {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: '.05em',
    padding: '3px 8px',
    borderRadius: 999,
    background: role === 'OWNER' ? 'rgba(18,67,59,.1)' : role === 'ADMIN' ? 'rgba(42,75,124,.1)' : C.bg4,
    color: role === 'OWNER' ? A : role === 'ADMIN' ? '#2A4B7C' : C.sub,
    flex: '0 0 auto',
  }
}

export function evDot(type: string): CSSProperties {
  const map: Record<string, string> = {
    created: '#667085',
    stage_change: A,
    owner_change: '#2A4B7C',
    reply_sent: C.ok,
    note_added: C.warn,
    follow_up_set: '#8A6D3B',
    win_probability_set: '#8A6D3B',
  }
  return { width: 9, height: 9, borderRadius: 999, background: map[type] ?? '#667085', flex: '0 0 auto', marginTop: 4 }
}

/** Big monospace KPI value. */
export function kpiValue(kind?: 'accent' | 'danger', value?: string): CSSProperties {
  return {
    fontFamily: mono,
    fontSize: 27,
    fontWeight: 600,
    letterSpacing: '-.01em',
    lineHeight: 1.05,
    color: kind === 'accent' ? A : kind === 'danger' && value !== '0' ? C.danger : C.text,
  }
}

export const shimmer = (h: number | string, extra: CSSProperties = {}): CSSProperties => ({
  height: h,
  borderRadius: 8,
  background: 'linear-gradient(90deg,#eeeee8,#f7f7f2,#eeeee8)',
  backgroundSize: '900px 100%',
  animation: 'll-shimmer 1.3s infinite',
  ...extra,
})
