import type { DragEvent, ReactNode } from 'react'
import { fmtDateShort, urgColor, usd } from '../compute'
import { useFiltered, useViews } from '../hooks'
import { ICalendar } from '../icons'
import { useDesk } from '../store'
import { C, chipStyle, mono, serif, tierChip } from '../styles'

export default function Pipeline(): ReactNode {
  const desk = useDesk()
  const { st, set } = desk
  const settings = st.settings!
  const filtered = useFiltered(useViews())

  const onDrop = (stage: string) => (e: DragEvent): void => {
    e.preventDefault()
    let id = st.dragId
    try {
      if (!id) id = e.dataTransfer.getData('text/plain')
    } catch {
      /* dataTransfer unavailable */
    }
    if (id) {
      const lead = filtered.find((l) => l.id === id)
      if (lead && lead.stage !== stage) {
        void desk.updateLead(id, { stage }).then((ok) => { if (ok) desk.toast(`Moved to ${stage}`) })
      }
    }
    set({ dragId: null, dragOver: null })
  }

  return (
    <div style={{ padding: 'clamp(16px,2.4vw,26px) clamp(16px,3vw,28px) 0', animation: 'll-fade .3s ease', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ marginBottom: 16, flex: '0 0 auto' }}>
        <div style={{ fontFamily: serif, fontSize: 23, fontWeight: 600 }}>Pipeline</div>
        <div style={{ fontSize: 12.5, color: C.sub, marginTop: 2 }}>
          Drag a card to change its stage. Column totals are weighted expected value.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 14, overflowX: 'auto', overflowY: 'hidden', paddingBottom: 20, flex: 1, alignItems: 'stretch' }}>
        {settings.stages.map((stage) => {
          const cards = filtered.filter((l) => l.stage === stage)
          const ev = cards.reduce((a, c) => a + c.ev, 0)
          const isTerminal = settings.closedStages.includes(stage)
          const isWon = stage === settings.wonStage
          const over = st.dragOver === stage
          return (
            <div
              key={stage}
              onDragOver={(e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move' } catch { /* noop */ } if (st.dragOver !== stage) set({ dragOver: stage }) }}
              onDrop={onDrop(stage)}
              style={{
                flex: '0 0 288px', width: 288, display: 'flex', flexDirection: 'column',
                background: over ? 'rgba(18,67,59,.05)' : '#F4F4EF', borderRadius: 12,
                border: `1px solid ${over ? 'rgba(18,67,59,.3)' : '#EAEAE3'}`,
                transition: 'background .15s,border-color .15s', maxHeight: '100%',
              }}
            >
              <div style={{ padding: '13px 13px 10px', flex: '0 0 auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{stage}</span>
                  <span style={{ fontFamily: mono, fontSize: 12, color: C.sub, background: '#fff', border: '1px solid #EAEAE3', borderRadius: 999, padding: '1px 8px', flex: '0 0 auto' }}>
                    {cards.length}
                  </span>
                </div>
                {(!isTerminal || isWon) && (
                  <div style={{ fontFamily: mono, fontSize: 12, color: '#12433B', marginTop: 6, fontWeight: 500 }}>
                    {usd(ev)} <span style={{ color: C.faint, fontWeight: 400 }}>{isWon ? 'won' : 'weighted'}</span>
                  </div>
                )}
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '2px 10px 12px', display: 'flex', flexDirection: 'column', gap: 9, minHeight: 80 }}>
                {cards.map((l) => {
                  const chip = tierChip(l.tier)
                  return (
                    <div
                      key={l.id}
                      draggable
                      onDragStart={(e) => { set({ dragId: l.id }); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', l.id) } catch { /* noop */ } }}
                      onDragEnd={() => set({ dragId: null, dragOver: null })}
                      onClick={() => set({ detailId: l.id })}
                      style={{
                        background: '#fff', border: `1px solid ${l.overdue ? 'rgba(180,35,24,.35)' : C.border}`,
                        borderRadius: 9, padding: '11px 12px', cursor: 'grab',
                        boxShadow: '0 1px 2px rgba(26,26,26,.04)', display: 'flex', flexDirection: 'column', gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                        <span style={chipStyle(l.tier)}>{chip.label}</span>
                      </div>
                      <div style={{ fontSize: 12, color: C.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: -2 }}>{l.org || '—'}</div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <div style={{ width: 8, height: 8, borderRadius: 999, background: urgColor(l.urgencyScore), flex: '0 0 auto' }} />
                          <span style={{ fontFamily: mono, fontWeight: 600, color: chip.fg, fontSize: 13 }}>{l.leadScore}</span>
                        </div>
                        <span style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 500 }}>{usd(l.ev)}</span>
                      </div>
                      {l.followUpDate && (
                        <div style={{ fontSize: 11, fontFamily: mono, display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ flex: '0 0 auto', opacity: 0.6, display: 'flex' }}>
                            <ICalendar size={11} strokeWidth={2} />
                          </span>
                          <span style={l.overdue ? { color: C.danger, fontWeight: 600 } : { color: C.sub }}>{fmtDateShort(l.followUpDate)}</span>
                        </div>
                      )}
                    </div>
                  )
                })}
                {cards.length === 0 && (
                  <div style={{ border: '1.5px dashed #DEDED6', borderRadius: 9, padding: '20px 10px', textAlign: 'center', color: C.ghost, fontSize: 12 }}>
                    No leads here
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
