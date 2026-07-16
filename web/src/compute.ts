import type { Filters, Lead, Settings, SortState } from './types'

/**
 * View-layer computation ported from the Lead Desk design prototype: display
 * expected value (won → deal midpoint, closed-not-won → $0, open → weighted),
 * overdue/stale/attention logic, filtering, sorting and formatting.
 */
export interface LeadView extends Lead {
  mid: number
  prob: number
  /** Display EV: mid when won, 0 for other closed stages, weighted when open. */
  ev: number
  isWon: boolean
  isTerminal: boolean
  isOpen: boolean
  overdue: boolean
  stale: boolean
  newToday: boolean
  timeInStageMs: number
  lastTouch: string
  ownerName: string | null
}

const DAY_MS = 86_400_000

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function stageEnteredAt(l: Lead): string {
  const events = (l.timeline ?? []).filter((e) => e.type === 'stage_change')
  if (events.length > 0) return events[events.length - 1]!.at
  const created = (l.timeline ?? []).find((e) => e.type === 'created')
  return created?.at ?? l.receivedAt
}

export function computeView(l: Lead, s: Settings, now: Date): LeadView {
  const mid = ((l.dealValueLow || 0) + (l.dealValueHigh || 0)) / 2
  const prob = l.winProbability
  const isWon = l.stage === s.wonStage
  const isTerminal = s.closedStages.includes(l.stage)
  const isOpen = !isTerminal
  const ev = isWon ? mid : isTerminal ? 0 : (l.expectedValue ?? mid * prob)
  const lastTouch = l.lastTouchedAt || l.receivedAt
  const overdue = !!(l.followUpDate && isOpen && new Date(l.followUpDate) < now)
  const stale = isOpen && (now.getTime() - new Date(lastTouch).getTime()) / DAY_MS > s.staleDays
  return {
    ...l,
    mid,
    prob,
    ev,
    isWon,
    isTerminal,
    isOpen,
    overdue,
    stale,
    newToday: sameDay(new Date(l.receivedAt), now),
    timeInStageMs: Math.max(0, now.getTime() - new Date(stageEnteredAt(l)).getTime()),
    lastTouch,
    ownerName: l.owner?.name ?? null,
  }
}

export function recentDays(l: LeadView, days: number, now: Date): boolean {
  return (now.getTime() - new Date(l.receivedAt).getTime()) / DAY_MS <= days
}

export function needsAttention(l: LeadView, now: Date): boolean {
  return l.isOpen && (l.tier === 'hot' || l.overdue || (!l.ownerName && recentDays(l, 3, now)) || l.stale)
}

export function attnRank(l: LeadView, now: Date): number {
  const over = l.overdue && l.followUpDate ? (now.getTime() - new Date(l.followUpDate).getTime()) / DAY_MS : 0
  return (
    (l.overdue ? 1000 : 0) +
    over +
    (l.tier === 'hot' ? 200 : 0) +
    (!l.ownerName && recentDays(l, 3, now) ? 60 : 0) +
    (l.stale ? 40 : 0) +
    l.leadScore
  )
}

export function attnReason(l: LeadView, now: Date): string {
  if (l.overdue) return 'Overdue follow-up'
  if (l.tier === 'hot') return 'Hot — reply fast'
  if (!l.ownerName && recentDays(l, 3, now)) return 'Unassigned & recent'
  if (l.stale) return 'Going stale'
  return 'Needs review'
}

/** ms from receipt to the first outbound touch (out-thread or reply_sent event). */
export function firstResponseMs(l: Lead): number | null {
  const outs = (l.threads ?? []).filter((t) => t.direction === 'out').map((t) => new Date(t.date).getTime())
  const events = (l.timeline ?? [])
    .filter((e) => e.type === 'reply_sent')
    .map((e) => new Date(e.at).getTime())
  const all = [...outs, ...events].sort((a, b) => a - b)
  if (all.length === 0) return null
  const ms = all[0]! - new Date(l.receivedAt).getTime()
  return ms > 0 ? ms : null
}

export function avgFrtLabel(all: Lead[]): string {
  const samples = all.map((l) => firstResponseMs(l)).filter((x): x is number => x != null)
  if (samples.length === 0) return '—'
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length
  const hours = avg / 3_600_000
  return hours >= 24 ? (hours / 24).toFixed(1) + 'd' : hours.toFixed(1) + 'h'
}

// ── filtering & sorting (mirrors the design prototype exactly) ─────────────

export function applyFilters(list: LeadView[], f: Filters, search: string, now: Date): LeadView[] {
  const q = (search || '').toLowerCase().trim()
  return list.filter((l) => {
    if (f.stages.length && !f.stages.includes(l.stage)) return false
    if (f.tiers.length && !f.tiers.includes(l.tier)) return false
    if (f.types.length && !f.types.includes(l.inquiryType)) return false
    if (f.sources.length && !f.sources.includes(l.source)) return false
    if (f.owners.length) {
      const owner = l.ownerName ?? 'Unassigned'
      if (!f.owners.includes(owner)) return false
    }
    if (l.fitScore < f.fitMin || l.fitScore > f.fitMax) return false
    if (l.urgencyScore < f.urgMin || l.urgencyScore > f.urgMax) return false
    if (l.leadScore < f.leadMin || l.leadScore > f.leadMax) return false
    if (f.evMin !== '' && l.ev < Number(f.evMin)) return false
    if (f.evMax !== '' && l.ev > Number(f.evMax)) return false
    if (f.recvFrom && new Date(l.receivedAt) < new Date(f.recvFrom)) return false
    if (f.recvTo && new Date(l.receivedAt) > new Date(f.recvTo + 'T23:59:59')) return false
    if (f.overdueOnly && !l.overdue) return false
    if (f.followFrom && (!l.followUpDate || new Date(l.followUpDate) < new Date(f.followFrom))) return false
    if (f.followTo && (!l.followUpDate || new Date(l.followUpDate) > new Date(f.followTo + 'T23:59:59'))) return false
    if (f.replySent === 'yes' && !l.replySent) return false
    if (f.replySent === 'no' && l.replySent) return false
    if (f.needsAttention && !needsAttention(l, now)) return false
    if (q) {
      const hay = [l.name, l.org, l.email, l.summary, l.notes].join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

export function sortRows(rows: LeadView[], sort: SortState, settings: Settings): LeadView[] {
  const dir = sort.dir === 'asc' ? 1 : -1
  const value = (l: LeadView): number | string => {
    switch (sort.col) {
      case 'received': return new Date(l.receivedAt).getTime()
      case 'name': return (l.name || '').toLowerCase()
      case 'org': return (l.org || '').toLowerCase()
      case 'type': return l.inquiryType || ''
      case 'tier': return { hot: 3, warm: 2, cold: 1 }[l.tier] ?? 0
      case 'fit': return l.fitScore
      case 'urgency': return l.urgencyScore
      case 'lead': return l.leadScore
      case 'ev': return l.ev
      case 'stage': return settings.stages.indexOf(l.stage)
      case 'owner': return (l.ownerName ?? '~~~').toLowerCase()
      case 'follow_up': return l.followUpDate ? new Date(l.followUpDate).getTime() : 8e15
      case 'last': return new Date(l.lastTouch).getTime()
    }
  }
  return rows.slice().sort((a, b) => {
    const av = value(a)
    const bv = value(b)
    if (av < bv) return -1 * dir
    if (av > bv) return 1 * dir
    return 0
  })
}

// ── formatting helpers ──────────────────────────────────────────────────────

export function usd(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '$0'
  return '$' + Math.round(n).toLocaleString('en-US')
}

export function usdApprox(n: number): string {
  if (n >= 1000) {
    const v = n / 1000
    return '$' + (v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '')) + 'k'
  }
  return '$' + Math.round(n)
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function relDays(iso: string, now: Date): string {
  const days = (now.getTime() - new Date(iso).getTime()) / DAY_MS
  if (days < 1) {
    const hours = Math.round(days * 24)
    return hours <= 0 ? 'just now' : hours + 'h ago'
  }
  return Math.round(days) + 'd ago'
}

export function durLabel(ms: number): string {
  const days = ms / DAY_MS
  if (days >= 1) return Math.round(days) + 'd'
  const hours = ms / 3_600_000
  if (hours >= 1) return Math.round(hours) + 'h'
  return Math.max(1, Math.round(ms / 60_000)) + 'm'
}

export function durLabelFull(ms: number): string {
  const days = Math.round(ms / DAY_MS)
  if (days >= 1) return days + (days === 1 ? ' day' : ' days')
  const hours = Math.round(ms / 3_600_000)
  return hours + (hours === 1 ? ' hour' : ' hours')
}

export function initials(name: string): string {
  return (name || '')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
}

export const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

export function numWord(n: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
  return words[n] ?? String(n)
}

export function urgColor(v: number): string {
  const alpha = Math.min(0.82, 0.16 + v * 0.075)
  return `rgba(26,26,26,${alpha.toFixed(2)})`
}

export const isoDate = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function prettyField(f: string): string {
  const map: Record<string, string> = {
    dealValueLow: 'Deal value (low)',
    dealValueHigh: 'Deal value (high)',
    fitScore: 'Fit score',
    urgencyScore: 'Urgency score',
    leadScore: 'Lead score',
    estWork: 'Estimated work',
    winProbability: 'Win probability',
  }
  return map[f] ?? f
}

/** Morning brief sentence, ported from the design. */
export function composeBrief(all: LeadView[], now: Date): string {
  const open = all.filter((l) => l.isOpen)
  const attn = open.filter((l) => needsAttention(l, now))
  const overdue = open
    .filter((l) => l.overdue)
    .sort((a, b) => new Date(a.followUpDate!).getTime() - new Date(b.followUpDate!).getTime())
  const hotNew = open.filter((l) => l.tier === 'hot' && recentDays(l, 1, now))
  const hotEv = hotNew.reduce((a, l) => a + l.ev, 0)
  let s1: string
  if (attn.length === 0) s1 = 'Nothing is on fire this morning — a good window to work the warm middle of your pipeline.'
  else if (attn.length === 1) s1 = 'One lead needs you today.'
  else s1 = cap(numWord(attn.length)) + ' leads need you today.'
  let s2 = ''
  if (overdue.length > 0) {
    const worst = overdue.slice().sort((a, b) => attnRank(b, now) - attnRank(a, now))[0]!
    const days = Math.max(1, Math.round((now.getTime() - new Date(worst.followUpDate!).getTime()) / DAY_MS))
    s2 = ` ${worst.org || worst.name}'s follow-up has sat ${numWord(days)} day${days === 1 ? '' : 's'} past due — clear it first.`
  } else if (attn.length > 0) {
    const top = attn.slice().sort((a, b) => attnRank(b, now) - attnRank(a, now))[0]!
    s2 = ` ${top.org || top.name} is the one to open first.`
  }
  let s3: string
  if (hotNew.length > 0) {
    s3 = ` ${cap(numWord(hotNew.length))} inbound ${hotNew.length === 1 ? 'request' : 'requests'} scored hot in the last day, together worth about ${usdApprox(hotEv)} weighted.`
  } else {
    s3 = ` Open pipeline is holding about ${usdApprox(open.reduce((a, l) => a + l.ev, 0))} in weighted value.`
  }
  return (s1 + s2 + s3).trim()
}

/** SVG line-chart geometry, ported from the design. */
export interface LineChart {
  viewBox: string
  points: string
  area: string
  dots: Array<{ cx: number; cy: number; label: string; showLabel: boolean }>
  last: string
}

export function lineChart(vals: number[], labels: string[], fmt: (v: number) => string): LineChart {
  const w = 560
  const h = 150
  const pad = 12
  const padB = 24
  const max = Math.max(1, ...vals)
  const n = vals.length
  const x = (i: number) => pad + (n <= 1 ? 0 : (i * (w - 2 * pad)) / (n - 1))
  const y = (v: number) => h - padB - (v / max) * (h - padB - pad)
  const points = vals.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const area = `M${x(0)},${h - padB} L` + vals.map((v, i) => `${x(i)},${y(v)}`).join(' L') + ` L${x(n - 1)},${h - padB} Z`
  const dots = vals.map((v, i) => ({
    cx: x(i),
    cy: y(v),
    label: labels[i] ?? '',
    showLabel: i % 2 === 1 || i === n - 1,
  }))
  return { viewBox: `0 0 ${w} ${h}`, points, area, dots, last: fmt(vals.length ? vals[vals.length - 1]! : 0) }
}
