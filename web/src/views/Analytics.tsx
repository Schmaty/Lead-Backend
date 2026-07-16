import type { ReactNode } from 'react'
import { firstResponseMs, fmtDateShort, lineChart, usd, usdApprox, type LeadView, type LineChart } from '../compute'
import { useViews } from '../hooks'
import { useDesk } from '../store'
import { A, C, card, kpiValue, mono, serif } from '../styles'

const DAY_MS = 86_400_000
const WEEKS = 8

function TrendCard({ title, sub, chart }: { title: string; sub: string; chart: LineChart }): ReactNode {
  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
          <div style={{ fontSize: 11.5, color: C.faint, marginTop: 2 }}>{sub}</div>
        </div>
        <div style={{ fontFamily: mono, fontSize: 15, fontWeight: 600, color: A }}>{chart.last}</div>
      </div>
      <svg viewBox={chart.viewBox} preserveAspectRatio="none" style={{ width: '100%', height: 150, overflow: 'visible' }}>
        <path d={chart.area} fill="rgba(18,67,59,.08)" />
        <polyline points={chart.points} fill="none" stroke={A} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {chart.dots.map((d, i) => (
          <circle key={i} cx={d.cx} cy={d.cy} r={2.5} fill={A} />
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.ghost, fontFamily: mono, marginTop: 4 }}>
        {chart.dots.filter((d) => d.showLabel).map((d, i) => (
          <span key={i}>{d.label}</span>
        ))}
      </div>
    </div>
  )
}

export default function Analytics(): ReactNode {
  const { st, set } = useDesk()
  const settings = st.settings!
  const all = useViews()
  const now = st.now

  const range = st.analyticsRange
  const cutoff = range === 'all' ? null : new Date(now.getTime() - Number(range) * DAY_MS)
  const list = cutoff ? all.filter((l) => new Date(l.receivedAt) >= cutoff) : all

  const won = list.filter((l) => l.stage === settings.wonStage)
  const lost = list.filter((l) => l.stage === settings.lostStage)
  const winRate = won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : 0
  const totalWon = won.reduce((a, l) => a + l.mid, 0)
  const avgDeal = won.length ? totalWon / won.length : 0
  const openEv = list.filter((l) => l.isOpen).reduce((a, l) => a + l.ev, 0)

  // Conversion funnel: leads that reached each stage (or beyond), from timeline history.
  const stageIdx = (s: string): number => settings.stages.indexOf(s)
  const openOrder = settings.stages.filter((s) => !settings.closedStages.includes(s))
  const funnelOrder = [...openOrder, settings.wonStage].filter((s) => stageIdx(s) >= 0)
  const maxIdxOf = (l: LeadView): number => {
    let max = stageIdx(l.stage)
    for (const e of l.timeline ?? []) {
      if (e.type !== 'stage_change') continue
      const to = e.detail.split('→').pop()?.trim() ?? ''
      const i = stageIdx(to)
      if (i > max) max = i
    }
    return max
  }
  const base = list.length || 1
  const conv = funnelOrder.map((stage) => ({ stage, count: list.filter((l) => maxIdxOf(l) >= stageIdx(stage)).length }))
  const convTop = Math.max(1, conv.length ? conv[0]!.count : 1)

  // Weekly series.
  const weekEnds = Array.from({ length: WEEKS }, (_, i) => new Date(now.getTime() - (WEEKS - 1 - i) * 7 * DAY_MS))
  const labels = weekEnds.map((d) => fmtDateShort(d.toISOString()))
  const evTrend = lineChart(
    weekEnds.map((end) =>
      Math.round(list.filter((l) => new Date(l.receivedAt) <= end && l.isOpen).reduce((a, l) => a + l.ev, 0)),
    ),
    labels,
    usdApprox,
  )
  const perWeek = weekEnds.map((end, i) => {
    const start = new Date(end.getTime() - 7 * DAY_MS)
    return {
      label: labels[i]!,
      count: list.filter((l) => { const d = new Date(l.receivedAt); return d > start && d <= end }).length,
    }
  })
  const perWeekMax = Math.max(1, ...perWeek.map((w) => w.count))
  const frt = lineChart(
    weekEnds.map((end) => {
      const start = new Date(end.getTime() - 7 * DAY_MS)
      const inWeek = list.filter((l) => { const d = new Date(l.receivedAt); return d > start && d <= end })
      const samples = inWeek.map((l) => firstResponseMs(l)).filter((x): x is number => x != null)
      return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length / 3_600_000 : 0
    }),
    labels,
    (v) => (v <= 0 ? '—' : v >= 24 ? (v / 24).toFixed(1) + 'd' : v.toFixed(1) + 'h'),
  )

  const srcCounts = settings.sources.map((src) => list.filter((l) => l.source === src).length)
  const srcMax = Math.max(1, ...srcCounts)
  const srcPerf = settings.sources.map((src, i) => {
    const ofSource = list.filter((l) => l.source === src)
    const w = ofSource.filter((l) => l.stage === settings.wonStage).length
    const lo = ofSource.filter((l) => l.stage === settings.lostStage).length
    return {
      label: src,
      volume: ofSource.length,
      winRate: w + lo ? Math.round((w / (w + lo)) * 100) + '%' : '—',
      pct: Math.max(srcCounts[i] ? 4 : 0, (srcCounts[i]! / srcMax) * 100),
    }
  })

  const calib = ([[0, 2], [3, 4], [5, 6], [7, 8], [9, 10]] as const).map(([lo, hi]) => {
    const inBand = list.filter((l) => l.leadScore >= lo && l.leadScore <= hi)
    const w = inBand.filter((l) => l.stage === settings.wonStage).length
    const lo2 = inBand.filter((l) => l.stage === settings.lostStage).length
    const wr = w + lo2 ? Math.round((w / (w + lo2)) * 100) : null
    return {
      label: `${lo}–${hi}`,
      count: inBand.length,
      winLabel: wr == null ? '—' : wr + '%',
      height: wr ?? 0,
      color: lo >= settings.tierThresholds.hot ? A : lo >= settings.tierThresholds.warm ? 'rgba(18,67,59,.6)' : 'rgba(18,67,59,.32)',
    }
  })

  const kpis = [
    { label: 'Win rate', value: `${winRate}%`, sub: `${won.length} won · ${lost.length} lost` },
    { label: 'Avg deal size', value: usd(avgDeal), sub: 'across won deals' },
    { label: 'Total won value', value: usd(totalWon), sub: `${won.length} deals`, kind: 'accent' as const },
    { label: 'Open pipeline EV', value: usd(openEv), sub: 'weighted' },
  ]

  return (
    <div style={{ padding: 'clamp(16px,2.4vw,26px) clamp(16px,3vw,28px)', maxWidth: 1280, margin: '0 auto', animation: 'll-fade .3s ease' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <div style={{ fontFamily: serif, fontSize: 23, fontWeight: 600 }}>Analytics</div>
          <div style={{ fontSize: 12.5, color: C.sub, marginTop: 2 }}>Pipeline health and score calibration, from your leads.</div>
        </div>
        <div style={{ display: 'flex', border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'hidden' }}>
          {([['30', '30 days'], ['60', '60 days'], ['90', '90 days'], ['all', 'All time']] as const).map(([value, label]) => (
            <button
              key={value}
              onClick={() => set({ analyticsRange: value })}
              style={{ padding: '7px 13px', fontSize: 12.5, fontWeight: range === value ? 600 : 500, cursor: 'pointer', border: 'none', background: range === value ? 'rgba(18,67,59,.09)' : '#fff', color: range === value ? A : C.sub }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(158px,1fr))', gap: 14, marginBottom: 18 }}>
        {kpis.map((k) => (
          <div key={k.label} style={{ ...card, borderRadius: 12, padding: '16px 18px' }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: C.sub }}>{k.label}</div>
            <div style={{ ...kpiValue(k.kind), lineHeight: undefined }}>{k.value}</div>
            <div style={{ fontSize: 11, color: C.faint, marginTop: 5 }}>{k.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 16 }}>
        <div style={card}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Conversion funnel</div>
          <div style={{ fontSize: 11.5, color: C.faint, marginBottom: 16 }}>Leads reaching each stage (or beyond)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {conv.map((c) => (
              <div key={c.stage}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                  <span style={{ color: C.body }}>{c.stage}</span>
                  <span style={{ fontFamily: mono, color: C.sub }}>
                    {c.count} · {Math.round((c.count / base) * 100)}%
                  </span>
                </div>
                <div style={{ height: 16, background: C.bg4, borderRadius: 5, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.max(c.count ? 4 : 0, (c.count / convTop) * 100)}%`, height: '100%', background: A, opacity: 0.85, borderRadius: 5 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Score calibration</div>
          <div style={{ fontSize: 11.5, color: C.faint, marginBottom: 16 }}>Win rate by lead-score band — does an 8 beat a 5?</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 150 }}>
            {calib.map((b) => (
              <div key={b.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', gap: 6 }}>
                <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: C.text }}>{b.winLabel}</div>
                <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end' }}>
                  <div style={{ height: `${b.height}%`, minHeight: b.height ? 4 : 0, background: b.color, borderRadius: '4px 4px 0 0', width: '100%' }} />
                </div>
                <div style={{ fontFamily: mono, fontSize: 10.5, color: C.sub }}>{b.label}</div>
                <div style={{ fontSize: 9.5, color: C.ghost }}>n={b.count}</div>
              </div>
            ))}
          </div>
        </div>
        <TrendCard title="Expected pipeline value" sub="Weighted, by receipt week" chart={evTrend} />
        <div style={card}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Leads per week</div>
          <div style={{ fontSize: 11.5, color: C.faint, marginBottom: 16 }}>Inbound volume</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 7, height: 150 }}>
            {perWeek.map((w) => (
              <div key={w.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', gap: 6 }}>
                <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end' }}>
                  <div style={{ height: `${(w.count / perWeekMax) * 100}%`, minHeight: w.count ? 4 : 0, background: A, opacity: 0.8, borderRadius: '3px 3px 0 0', width: '100%' }} />
                </div>
                <div style={{ fontFamily: mono, fontSize: 9.5, color: C.ghost, whiteSpace: 'nowrap' }}>{w.label}</div>
              </div>
            ))}
          </div>
        </div>
        <TrendCard title="First-response time" sub="Avg time to first reply, by week" chart={frt} />
        <div style={card}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Source performance</div>
          <div style={{ fontSize: 11.5, color: C.faint, marginBottom: 16 }}>Volume and win rate by source</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {srcPerf.map((s) => (
              <div key={s.label}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                  <span style={{ color: C.body }}>{s.label}</span>
                  <span style={{ fontFamily: mono, color: C.sub }}>{s.volume} leads · {s.winRate} win</span>
                </div>
                <div style={{ height: 14, background: C.bg4, borderRadius: 5, overflow: 'hidden' }}>
                  <div style={{ width: `${s.pct}%`, height: '100%', background: A, opacity: 0.8, borderRadius: 4 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
