import type { CSSProperties, ReactNode } from 'react'
import {
  attnRank,
  attnReason,
  avgFrtLabel,
  composeBrief,
  needsAttention,
  urgColor,
  usd,
  type LeadView,
} from '../compute'
import { useViews } from '../hooks'
import { useDesk } from '../store'
import { A, C, cardTight, chipStyle, kpiValue, mono, serif, tierChip } from '../styles'

function BarRow({ label, count, max, opacity }: { label: string; count: number; max: number; opacity: number }): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 104, fontSize: 11.5, color: C.sub, textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 0 auto' }}>
        {label}
      </div>
      <div style={{ flex: 1, height: 13, background: C.bg4, borderRadius: 4, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ width: `${Math.max(count ? 6 : 0, (count / max) * 100)}%`, height: '100%', background: A, opacity: count ? opacity : 0, borderRadius: 4 }} />
      </div>
      <div style={{ width: 20, fontFamily: mono, fontSize: 12, textAlign: 'right', flex: '0 0 auto' }}>{count}</div>
    </div>
  )
}

export default function Today(): ReactNode {
  const desk = useDesk()
  const { st, set } = desk
  const settings = st.settings!
  const all = useViews()
  const now = st.now

  const open = all.filter((l) => l.isOpen)
  const pipelineEv = open.reduce((a, l) => a + l.ev, 0)
  const overdueN = open.filter((l) => l.overdue).length
  const staleN = open.filter((l) => l.stale).length
  const hotN = open.filter((l) => l.tier === 'hot').length
  const newN = all.filter((l) => l.newToday).length

  const kpis: Array<{ label: string; value: string; sub: string; kind?: 'accent' | 'danger' }> = [
    { label: 'New today', value: String(newN), sub: 'inbound leads' },
    { label: 'Hot & open', value: String(hotN), sub: 'need a fast reply' },
    { label: 'Pipeline expected value', value: usd(pipelineEv), sub: 'weighted · open stages', kind: 'accent' },
    { label: 'Overdue follow-ups', value: String(overdueN), sub: staleN ? `${staleN} also going stale` : 'past due', kind: 'danger' },
    { label: 'Avg first response', value: avgFrtLabel(all), sub: 'time to first reply' },
  ]

  const queue = open
    .filter((l) => needsAttention(l, now))
    .sort((a, b) => attnRank(b, now) - attnRank(a, now))

  const reasonStyle = (l: LeadView): CSSProperties => {
    const pair = l.overdue
      ? [C.danger, 'rgba(180,35,24,.08)']
      : l.tier === 'hot'
        ? [C.danger, 'rgba(180,35,24,.06)']
        : [C.sub, C.bg4]
    return { color: pair[0], background: pair[1], fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap', flex: '0 0 auto' }
  }

  const funnel = settings.stages.map((stage) => ({ stage, count: all.filter((l) => l.stage === stage).length }))
  const funnelMax = Math.max(1, ...funnel.map((x) => x.count))
  const srcmix = settings.sources.map((source) => ({ source, count: all.filter((l) => l.source === source).length }))
  const srcMax = Math.max(1, ...srcmix.map((x) => x.count))
  const hist = Array.from({ length: 11 }, (_, score) => ({ score, count: all.filter((l) => l.leadScore === score).length }))
  const histMax = Math.max(1, ...hist.map((x) => x.count))

  return (
    <div style={{ padding: 'clamp(20px,3vw,34px)', maxWidth: 1300, margin: '0 auto', animation: 'll-fade .3s ease' }}>
      <div style={{ fontFamily: serif, fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', color: '#8A8A80', marginBottom: 14 }}>
        {now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · your brief
      </div>
      <div style={{ background: 'rgba(18,67,59,.05)', borderRadius: 16, padding: 'clamp(20px,3vw,34px)' }}>
        <p style={{ fontFamily: serif, fontSize: 'clamp(20px,2.4vw,27px)', lineHeight: 1.5, color: C.text, margin: 0, textWrap: 'pretty', maxWidth: '64ch' }}>
          {composeBrief(all, now)}
        </p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(158px,1fr))', gap: 14, marginTop: 22 }}>
        {kpis.map((k) => (
          <div key={k.label} style={{ ...cardTight, padding: '16px 18px' }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '.02em', color: C.sub, lineHeight: 1.3, minHeight: 29 }}>{k.label}</div>
            <div style={kpiValue(k.kind, k.value)}>{k.value}</div>
            <div style={{ fontSize: 11, color: C.faint, marginTop: 5 }}>{k.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginTop: 20, alignItems: 'flex-start' }}>
        <div style={{ flex: '1.7 1 340px', minWidth: 0, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, boxShadow: '0 1px 2px rgba(26,26,26,.04)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px 12px' }}>
            <div style={{ fontWeight: 600, fontSize: 14.5 }}>Needs you today</div>
            <div style={{ fontFamily: mono, fontSize: 12, color: C.sub }}>{queue.length}</div>
          </div>
          {queue.length > 0 ? (
            <div>
              {queue.map((l) => {
                const chip = tierChip(l.tier)
                return (
                  <div
                    key={l.id}
                    className="hv-row"
                    onClick={() => set({ detailId: l.id })}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderTop: `1px solid ${C.line}`, cursor: 'pointer', transition: 'background .12s' }}
                  >
                    <div style={{ width: 8, height: 8, borderRadius: 999, background: urgColor(l.urgencyScore), flex: '0 0 auto' }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name}</span>
                        <span style={chipStyle(l.tier)}>{chip.label}</span>
                      </div>
                      <div style={{ fontSize: 12.5, color: C.sub, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {l.org || '—'} · {l.recommendedNextStep || '—'}
                      </div>
                    </div>
                    <span style={reasonStyle(l)}>{attnReason(l, now)}</span>
                    <div style={{ textAlign: 'right', flex: '0 0 auto', minWidth: 62 }}>
                      <div style={{ fontFamily: mono, fontWeight: 600, color: chip.fg, fontSize: 13 }}>{l.leadScore}</div>
                      <div style={{ fontFamily: mono, fontSize: 12, color: C.sub }}>{usd(l.ev)}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div style={{ padding: '34px 18px', textAlign: 'center', color: C.sub, fontSize: 13.5, borderTop: `1px solid ${C.line}` }}>
              You&apos;re all clear — nothing needs attention right now.
            </div>
          )}
        </div>
        <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ ...cardTight, padding: '16px 18px' }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 12 }}>Stage funnel</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {funnel.map((row) => (
                <BarRow key={row.stage} label={row.stage} count={row.count} max={funnelMax} opacity={0.9} />
              ))}
            </div>
          </div>
          <div style={{ ...cardTight, padding: '16px 18px' }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 12 }}>Source mix</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {srcmix.map((row) => (
                <BarRow key={row.source} label={row.source} count={row.count} max={srcMax} opacity={0.78} />
              ))}
            </div>
          </div>
          <div style={{ ...cardTight, padding: '16px 18px' }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>Lead score distribution</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 96 }}>
              {hist.map((h) => (
                <div key={h.score} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', gap: 5 }}>
                  <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end' }}>
                    <div
                      style={{
                        height: `${(h.count / histMax) * 100}%`,
                        minHeight: h.count ? 3 : 0,
                        background: h.score >= settings.tierThresholds.hot ? A : h.score >= settings.tierThresholds.warm ? 'rgba(18,67,59,.55)' : 'rgba(18,67,59,.28)',
                        borderRadius: '3px 3px 0 0',
                        width: '100%',
                      }}
                    />
                  </div>
                  <div style={{ fontFamily: mono, fontSize: 10, color: C.faint }}>{h.score}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
