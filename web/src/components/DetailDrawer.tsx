import { useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import {
  computeView,
  durLabel,
  durLabelFull,
  fmtDate,
  fmtDateTime,
  prettyField,
  usd,
} from '../compute'
import { useOwnerOpts } from '../hooks'
import { ICopy, ISend, IX, IZap } from '../icons'
import { useDesk } from '../store'
import LeadEnrichment from './LeadEnrichment'
import { A, C, chipStyle, evDot, mono, serif, tierChip, upLabel } from '../styles'

const selectS: CSSProperties = { width: '100%', padding: '8px 9px', border: `1px solid ${C.border2}`, borderRadius: 8, fontSize: 13, background: '#fff' }
const microLabel: CSSProperties = { fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#8A8A80', marginBottom: 6 }

export default function DetailDrawer(): ReactNode {
  const desk = useDesk()
  const { st, set } = desk
  const settings = st.settings!
  const { names: ownerNames, idFor } = useOwnerOpts()
  const probTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const lead = st.leads.find((l) => l.id === st.detailId)
  const view = useMemo(() => (lead ? computeView(lead, settings, st.now) : null), [lead, settings, st.now])
  if (!lead || !view) return null

  const chip = tierChip(view.tier)
  const draft = st.draftEdits[lead.id] ?? lead.draftReply ?? ''
  const notes = st.notesEdits[lead.id] ?? lead.notes ?? ''
  const prob = Math.round(view.prob * 100)
  const breakdown = view.isWon
    ? `Won · ${usd(view.mid)}`
    : view.isTerminal
      ? `${usd(0)} to pipeline · ${lead.stage}`
      : `midpoint ${usd(view.mid)} × ${prob}% = ${usd(view.ev)}`

  const inferred = new Set(lead.inferredFields)
  const scores = [
    { label: 'Fit', v: lead.fitScore, inferred: inferred.has('fitScore'), color: A },
    { label: 'Urgency', v: lead.urgencyScore, inferred: inferred.has('urgencyScore'), color: A },
    { label: 'Lead', v: lead.leadScore, inferred: false, color: chip.fg },
  ]

  const events = lead.timeline ?? []
  const timeline = events
    .map((e, i) => ({
      ...e,
      held:
        e.type === 'stage_change'
          ? durLabel((i < events.length - 1 ? new Date(events[i + 1]!.at).getTime() : st.now.getTime()) - new Date(e.at).getTime())
          : null,
    }))
    .reverse()

  const close = (): void => set({ detailId: null })
  const copyDraft = (): void => {
    const done = (): void => desk.toast('Draft copied to clipboard')
    const fallback = (): void => {
      try {
        const ta = document.createElement('textarea')
        ta.value = draft
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
        done()
      } catch {
        desk.toast('Copy not available here')
      }
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(draft).then(done, fallback)
    else fallback()
  }
  const commitNotes = (): void => {
    const buffer = st.notesEdits[lead.id]
    if (buffer == null || buffer === (lead.notes ?? '')) return
    void desk.updateLead(lead.id, { notes: buffer })
  }
  const setProb = (pct: number): void => {
    // Optimistic local buffer via draftEdits? Keep simple: debounce the PATCH.
    if (probTimer.current) clearTimeout(probTimer.current)
    probTimer.current = setTimeout(() => void desk.updateLead(lead.id, { winProbability: Math.max(0, Math.min(1, pct / 100)) }), 350)
  }
  const canDelete = st.user!.role !== 'MEMBER'
  // Probability math is developer-only; daily users see plain dollar figures.
  const showTechnical = !!st.user?.developer

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={close} style={{ position: 'absolute', inset: 0, background: 'rgba(26,26,26,.30)', animation: 'll-scrim .2s ease' }} />
      <div style={{ position: 'relative', width: 'min(500px,100vw)', height: '100vh', background: '#fff', boxShadow: '-14px 0 44px rgba(26,26,26,.16)', overflowY: 'auto', animation: 'll-panel .28s cubic-bezier(.22,1,.36,1)' }}>
        <div style={{ padding: '20px 24px 16px', borderBottom: `1px solid ${C.line}`, position: 'sticky', top: 0, background: 'rgba(255,255,255,.94)', backdropFilter: 'blur(6px)', zIndex: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                <span style={chipStyle(view.tier)}>{chip.label}</span>
                <span style={{ fontSize: 11, color: C.faint, fontFamily: mono }}>#{lead.externalId ?? lead.id.slice(-8)}</span>
              </div>
              <div style={{ fontFamily: serif, fontSize: 23, fontWeight: 600, marginTop: 9, lineHeight: 1.15, textWrap: 'pretty' }}>{lead.name}</div>
              {!!lead.org && <div style={{ fontSize: 14, color: C.body, marginTop: 2 }}>{lead.org}</div>}
              <div style={{ fontSize: 11.5, color: C.faint, marginTop: 9, display: 'flex', flexWrap: 'wrap', gap: '3px 9px' }}>
                <span>{lead.email}</span>
                <span>· {lead.source}</span>
                <span>· {fmtDate(lead.receivedAt)}</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flex: '0 0 auto' }}>
              <button onClick={close} style={{ background: C.bg4, border: 'none', width: 32, height: 32, borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.body }}>
                <IX size={16} strokeWidth={2} />
              </button>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: serif, fontSize: 46, fontWeight: 600, lineHeight: 1, color: chip.fg }}>{lead.leadScore}</div>
                <div style={{ fontSize: 10, color: C.faint, letterSpacing: '.06em', textTransform: 'uppercase', marginTop: 2 }}>Lead score</div>
              </div>
            </div>
          </div>
        </div>
        <div style={{ padding: '20px 24px 40px' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 22 }}>
            <div style={{ flex: 1, minWidth: 130 }}>
              <div style={microLabel}>Stage</div>
              <select value={lead.stage} onChange={(e) => void desk.updateLead(lead.id, { stage: e.target.value })} style={selectS}>
                {settings.stages.map((s) => (<option key={s} value={s}>{s}</option>))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 120 }}>
              <div style={microLabel}>Owner</div>
              <select
                value={view.ownerName ?? 'Unassigned'}
                onChange={(e) => void desk.updateLead(lead.id, { ownerId: e.target.value === 'Unassigned' ? null : idFor(e.target.value) })}
                style={selectS}
              >
                {ownerNames.map((o) => (<option key={o} value={o}>{o}</option>))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 120 }}>
              <div style={microLabel}>Follow-up</div>
              <input
                type="date"
                value={lead.followUpDate ? lead.followUpDate.slice(0, 10) : ''}
                onChange={(e) => void desk.updateLead(lead.id, { followUpDate: e.target.value || null })}
                style={{ ...selectS, padding: '7px 9px', fontSize: 12.5 }}
              />
            </div>
          </div>
          {view.overdue && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(180,35,24,.07)', color: C.danger, borderRadius: 8, padding: '8px 12px', fontSize: 12.5, fontWeight: 500, marginBottom: 20, marginTop: -6 }}>
              Follow-up is overdue — clear it or reschedule.
            </div>
          )}

          <div style={{ marginBottom: 22 }}>
            <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 12 }}>Scores</div>
            {scores.map((s) => (
              <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <div style={{ width: 64, fontSize: 12.5, color: C.body, flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 5 }}>
                  {s.label}
                  {s.inferred && (
                    <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: C.warn, background: 'rgba(181,71,8,.1)', padding: '1px 5px', borderRadius: 4 }}>est</span>
                  )}
                </div>
                <div style={{ flex: 1, height: 7, background: C.bg4, borderRadius: 999, overflow: 'hidden' }}>
                  <div style={{ width: `${(s.v / 10) * 100}%`, height: '100%', background: s.color, borderRadius: 999 }} />
                </div>
                <div style={{ width: 34, textAlign: 'right', fontFamily: mono, fontSize: 13, fontWeight: 600, flex: '0 0 auto' }}>{s.v}</div>
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 22 }}>
            <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 12 }}>Why this score</div>
            {lead.fitReasons.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 12 }}>
                {lead.fitReasons.map((r) => (
                  <div key={r} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 13, color: C.text }}>
                    <span style={{ color: A, flex: '0 0 auto', marginTop: 1 }}>✓</span>
                    <span>{r}</span>
                  </div>
                ))}
              </div>
            )}
            {lead.riskFlags.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {lead.riskFlags.map((f) => (
                  <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 13, color: C.body }}>
                    <span style={{ color: C.warn, flex: '0 0 auto', marginTop: 1 }}>!</span>
                    <span>{f}</span>
                  </div>
                ))}
              </div>
            )}
            {lead.inferredFields.length > 0 && (
              <div style={{ marginTop: 12, fontSize: 11.5, color: '#8A8A80' }}>
                Estimated (not confirmed):{' '}
                {lead.inferredFields.map((f) => (
                  <span key={f} style={{ color: C.warn, fontWeight: 500 }}>{prettyField(f)} · </span>
                ))}
              </div>
            )}
          </div>

          <div style={{ background: 'rgba(18,67,59,.05)', borderRadius: 12, padding: '16px 18px', marginBottom: 22 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 4 }}>Deal range</div>
                <div style={{ fontFamily: mono, fontSize: 15, fontWeight: 500 }}>{usd(lead.dealValueLow)}–{usd(lead.dealValueHigh)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 4 }}>{showTechnical ? 'Expected value' : 'Est. value'}</div>
                <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 600, color: A }}>{usd(view.ev)}</div>
              </div>
            </div>
            {/* The probability math is developer-only — daily users just see the number. */}
            {showTechnical && (
              <>
                <div style={{ fontFamily: mono, fontSize: 12, color: C.sub, marginTop: 10, paddingTop: 12, borderTop: '1px solid rgba(18,67,59,.12)' }}>{breakdown}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
                  <span style={{ fontSize: 12, color: C.body, flex: '0 0 auto' }}>Win probability</span>
                  <input type="range" min={0} max={100} step={5} defaultValue={prob} onChange={(e) => setProb(Number(e.target.value))} style={{ flex: 1, accentColor: A }} />
                  <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, width: 44, textAlign: 'right', flex: '0 0 auto' }}>{prob}%</span>
                </div>
                <div style={{ fontSize: 11, color: C.faint, marginTop: 8 }}>
                  Expected deal value, weighted by likelihood — not net profit (cost-to-serve isn&apos;t modeled).
                </div>
              </>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, border: '1px solid rgba(18,67,59,.25)', borderRadius: 12, padding: '14px 16px', marginBottom: 22 }}>
            <span style={{ color: A, flex: '0 0 auto', marginTop: 1, display: 'flex' }}>
              <IZap size={18} strokeWidth={1.8} />
            </span>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: A, marginBottom: 4 }}>Suggested next step</div>
              <div style={{ fontSize: 14, lineHeight: 1.5, color: C.text }}>{lead.recommendedNextStep || '—'}</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginBottom: 24 }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 8 }}>Estimated work</div>
              <div style={{ fontSize: 13, lineHeight: 1.55, color: C.body }}>{lead.estWork || '—'}</div>
            </div>
            <div style={{ flex: 1.4, minWidth: 200 }}>
              <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 8 }}>Summary</div>
              <div style={{ fontSize: 13, lineHeight: 1.55, color: C.body }}>{lead.summary || '—'}</div>
            </div>
          </div>

          <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 0 }}>Draft reply</div>
              {lead.replySent && (
                <span style={{ fontSize: 11, fontWeight: 600, color: C.ok, background: 'rgba(31,138,91,.1)', padding: '2px 9px', borderRadius: 999 }}>Reply sent</span>
              )}
            </div>
            <textarea
              value={draft}
              onChange={(e) => set((s) => ({ draftEdits: { ...s.draftEdits, [lead.id]: e.target.value } }))}
              placeholder="No draft was generated for this lead — write one here."
              style={{ width: '100%', minHeight: 120, padding: '12px 14px', border: `1px solid ${C.border2}`, borderRadius: 10, fontSize: 13, lineHeight: 1.55, resize: 'vertical', background: C.bg2, color: C.text }}
            />
            <div style={{ display: 'flex', gap: 9, marginTop: 10 }}>
              <button onClick={copyDraft} style={{ display: 'flex', alignItems: 'center', gap: 7, background: '#fff', border: `1px solid ${C.border2}`, borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: C.text }}>
                <ICopy size={14} strokeWidth={1.8} />
                Copy
              </button>
              <button className="hv-dark" onClick={() => void desk.markSent(lead.id, lead.stage)} style={{ display: 'flex', alignItems: 'center', gap: 7, background: A, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                <ISend size={14} strokeWidth={1.8} />
                Mark reply sent
              </button>
            </div>
          </div>

          <div style={{ marginBottom: 24 }}>
            <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 12 }}>Emails</div>
            {(lead.threads ?? []).length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(lead.threads ?? []).slice(-12).map((t) => (
                  <div key={t.id} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase', padding: '2px 8px', borderRadius: 999, ...(t.direction === 'in' ? { color: A, background: 'rgba(18,67,59,.09)' } : { color: C.sub, background: C.bg4 }) }}>
                        {t.direction === 'in' ? 'In' : 'Out'}
                      </span>
                      <span style={{ fontWeight: 600, fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.subject}</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.5, marginBottom: 8 }}>{t.snippet}</div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <span style={{ fontSize: 11.5, color: C.faint, fontFamily: mono }}>{fmtDate(t.date)}</span>
                      {!!t.url && (
                        <a href={t.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 600, color: A }}>
                          Open in Gmail ↗
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: C.faint }}>No related email threads.</div>
            )}
          </div>

          <LeadEnrichment lead={lead} />

          <div style={{ marginBottom: 24 }}>
            <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 10 }}>Notes</div>
            <textarea
              value={notes}
              onChange={(e) => set((s) => ({ notesEdits: { ...s.notesEdits, [lead.id]: e.target.value } }))}
              onBlur={commitNotes}
              placeholder="Add a private note (saved on blur)…"
              style={{ width: '100%', minHeight: 64, padding: '11px 13px', border: `1px solid ${C.border2}`, borderRadius: 10, fontSize: 13, lineHeight: 1.5, resize: 'vertical', background: C.bg2, color: C.text }}
            />
          </div>

          <div style={{ marginBottom: canDelete ? 24 : 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 0 }}>Activity</div>
              <span style={{ fontSize: 11.5, color: C.faint }}>In stage {durLabelFull(view.timeInStageMs)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {timeline.map((e) => (
                <div key={e.id} style={{ display: 'flex', gap: 12 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '0 0 auto' }}>
                    <div style={evDot(e.type)} />
                    <div style={{ width: 1, flex: 1, background: C.line, minHeight: 14 }} />
                  </div>
                  <div style={{ paddingBottom: 16, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: C.text }}>{e.detail}</div>
                    <div style={{ fontSize: 11, color: C.faint, marginTop: 2, fontFamily: mono }}>
                      {fmtDateTime(e.at)} · {e.actor}
                      {e.held ? ` · held ${e.held}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {canDelete && (
            <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 16 }}>
              <button
                onClick={() => { if (window.confirm(`Delete "${lead.name}"? The lead disappears from every view.`)) void desk.deleteLead(lead.id) }}
                style={{ background: 'none', border: '1px solid rgba(180,35,24,.35)', color: C.danger, borderRadius: 8, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
              >
                Delete lead
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
