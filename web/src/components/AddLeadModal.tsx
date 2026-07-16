import type { CSSProperties, ReactNode } from 'react'
import { IX } from '../icons'
import { blankAdd, useDesk } from '../store'
import { C, mono, serif } from '../styles'

const label: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#8A8A80', marginBottom: 6 }
const input: CSSProperties = { width: '100%', padding: '9px 11px', border: `1px solid ${C.border2}`, borderRadius: 8, fontSize: 13.5 }
const selectS: CSSProperties = { width: '100%', padding: '9px 10px', border: `1px solid ${C.border2}`, borderRadius: 8, fontSize: 13, background: '#fff' }

export default function AddLeadModal(): ReactNode {
  const desk = useDesk()
  const { st, set } = desk
  const settings = st.settings!
  const form = st.addForm
  const valid = !!(form.name && form.email)

  const close = (): void => set((s) => ({ addOpen: false, addForm: blankAdd(s.settings) }))
  const field = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    set((s) => ({ addForm: { ...s.addForm, [key]: e.target.value } }))

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={close} style={{ position: 'absolute', inset: 0, background: 'rgba(26,26,26,.32)', animation: 'll-scrim .2s ease' }} />
      <div style={{ position: 'relative', width: 'min(480px,100%)', maxHeight: '90vh', overflowY: 'auto', background: '#fff', borderRadius: 16, boxShadow: '0 20px 60px rgba(26,26,26,.24)', animation: 'll-fade .22s ease' }}>
        <div style={{ padding: '20px 24px 14px', borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontFamily: serif, fontSize: 19, fontWeight: 600 }}>Add a lead</div>
          <button onClick={close} style={{ background: C.bg4, border: 'none', width: 30, height: 30, borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.body }}>
            <IX size={15} strokeWidth={2} />
          </button>
        </div>
        <div style={{ padding: '18px 24px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 150 }}>
              <div style={label}>Name *</div>
              <input value={form.name} onChange={field('name')} placeholder="Jane Doe" style={input} />
            </div>
            <div style={{ flex: 1, minWidth: 150 }}>
              <div style={label}>Email *</div>
              <input value={form.email} onChange={field('email')} placeholder="jane@acme.com" style={input} />
            </div>
          </div>
          <div>
            <div style={label}>Organization</div>
            <input value={form.org} onChange={field('org')} placeholder="Acme Co" style={input} />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 150 }}>
              <div style={label}>Source</div>
              <select value={form.source} onChange={field('source')} style={selectS}>
                {settings.sources.map((s) => (<option key={s} value={s}>{s}</option>))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 150 }}>
              <div style={label}>Inquiry type</div>
              <select value={form.inquiryType} onChange={field('inquiryType')} style={selectS}>
                {settings.inquiryTypes.map((t) => (<option key={t} value={t}>{t}</option>))}
              </select>
            </div>
          </div>
          <div>
            <div style={label}>Inquiry / summary</div>
            <textarea
              value={form.summary}
              onChange={field('summary')}
              placeholder="What are they asking for?"
              style={{ width: '100%', minHeight: 70, padding: '10px 12px', border: `1px solid ${C.border2}`, borderRadius: 8, fontSize: 13, lineHeight: 1.5, resize: 'vertical' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 110 }}>
              <div style={label}>Deal low ($)</div>
              <input type="number" min={0} value={form.dealLow} onChange={field('dealLow')} placeholder="0" style={{ ...input, fontSize: 13, fontFamily: mono }} />
            </div>
            <div style={{ flex: 1, minWidth: 110 }}>
              <div style={label}>Deal high ($)</div>
              <input type="number" min={0} value={form.dealHigh} onChange={field('dealHigh')} placeholder="0" style={{ ...input, fontSize: 13, fontFamily: mono }} />
            </div>
            <div style={{ flex: 1, minWidth: 130 }}>
              <div style={label}>Lead score {form.leadScore}</div>
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={form.leadScore}
                onChange={(e) => set((s) => ({ addForm: { ...s.addForm, leadScore: Number(e.target.value) } }))}
                style={{ width: '100%', accentColor: '#12433B', marginTop: 8 }}
              />
            </div>
          </div>
        </div>
        <div style={{ padding: '14px 24px 20px', borderTop: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 11.5, color: C.faint }}>
            New leads land in <strong style={{ color: C.body, fontWeight: 600 }}>New</strong>, unassigned.
          </div>
          <div style={{ display: 'flex', gap: 9 }}>
            <button onClick={close} style={{ background: '#fff', border: `1px solid ${C.border2}`, borderRadius: 8, padding: '10px 16px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', color: C.body }}>
              Cancel
            </button>
            <button
              onClick={() => { if (valid) void desk.addLead(form) }}
              style={{ background: valid ? '#12433B' : '#AEBCB8', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13.5, fontWeight: 600, cursor: valid ? 'pointer' : 'not-allowed' }}
            >
              Add lead
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
