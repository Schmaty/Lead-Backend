import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { api } from '../api'
import { fmtDate } from '../compute'
import { useDesk } from '../store'
import { A, C, mono, upLabel } from '../styles'
import type { CrmLookup, CrmPrefill, Lead, Meeting, Person } from '../types'

const box: CSSProperties = { border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 14px' }

/**
 * The enrichment panels on a lead: people profiles (who reached out, who was
 * in meetings — with their messages), meeting intel from the transcript
 * provider, and the CRM panel (read now, push coming soon). People/meetings
 * ride on the detail fetch; the list payload doesn't carry them.
 */
export default function LeadEnrichment({ lead }: { lead: Lead }): ReactNode {
  const desk = useDesk()
  const [detail, setDetail] = useState<Lead | null>(null)
  const [crm, setCrm] = useState<CrmLookup | null>(null)
  const [crmBusy, setCrmBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState<CrmPrefill | null>(null)
  const [pushBusy, setPushBusy] = useState(false)
  const [scopeBlocked, setScopeBlocked] = useState(false)

  useEffect(() => {
    setDetail(null)
    setCrm(null)
    let cancelled = false
    void api.getLead(lead.id).then((full) => {
      if (cancelled) return
      setDetail(full)
      // The scan already pulls the CRM — show its cached matches instantly.
      if (full.crmCheckedAt) {
        setCrm({ available: true, records: full.crmRecords ?? [], checkedAt: full.crmCheckedAt, createUrl: 'https://crm.zoho.com/crm/tab/Leads/create' })
      }
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [lead.id])

  const people: Person[] = detail?.people ?? []
  const meetings: Meeting[] = detail?.meetings ?? []
  const threads = detail?.threads ?? lead.threads ?? []
  const messageCount = (personId: string): number => threads.filter((t) => t.personId === personId).length

  const lookupCrm = async (): Promise<void> => {
    setCrmBusy(true)
    try {
      setCrm(await api.leadCrm(lead.id))
    } catch (e) {
      desk.toast(e instanceof Error ? e.message : 'CRM lookup failed')
    } finally {
      setCrmBusy(false)
    }
  }

  // Prefill the popup from the lead (mirrors the backend's buildCrmPrefill).
  const computePrefill = (l: Lead): CrmPrefill => {
    const [first, ...rest] = (l.name || '').trim().split(/\s+/).filter(Boolean)
    const phone = (l.people ?? []).find((p) => p.phone)?.phone ?? ''
    const value = l.estPayoutRaw || (l.dealValueHigh ? `$${l.dealValueLow.toLocaleString()}–$${l.dealValueHigh.toLocaleString()}` : '')
    const description = [
      l.summary,
      value ? `Estimated value: ${value}` : '',
      l.inquiryType ? `Inquiry: ${l.inquiryType}` : '',
      `Lead score: ${l.leadScore}/10 · stage: ${l.stage}`,
      l.recommendedNextStep ? `Next step: ${l.recommendedNextStep}` : '',
      'Added from Leadline.',
    ].filter(Boolean).join('\n')
    return {
      firstName: rest.length ? first ?? '' : '',
      lastName: rest.length ? rest.join(' ') : first ?? '',
      email: l.email, company: l.org, phone, title: '', leadSource: 'Leadline', description,
    }
  }

  const openAdd = (): void => {
    setForm(crm?.prefill ?? computePrefill(detail ?? lead))
    setScopeBlocked(false)
    setAddOpen(true)
  }
  const setField = (key: keyof CrmPrefill, value: string): void => setForm((f) => (f ? { ...f, [key]: value } : f))

  const copyDetails = (): void => {
    if (!form) return
    const text = [
      `First name: ${form.firstName}`, `Last name: ${form.lastName}`, `Company: ${form.company}`,
      `Title: ${form.title}`, `Email: ${form.email}`, `Phone: ${form.phone}`,
      `Lead source: ${form.leadSource}`, `Description: ${form.description}`,
    ].join('\n')
    navigator.clipboard?.writeText(text).then(
      () => desk.toast('Lead details copied — paste into Zoho'),
      () => desk.toast('Could not copy'),
    )
  }

  const pushToCrm = async (): Promise<void> => {
    if (!form) return
    setPushBusy(true)
    try {
      const res = await api.crmPush(lead.id, form)
      if (res.ok && res.url) {
        desk.toast('Added to Zoho CRM ✓')
        window.open(res.url, '_blank', 'noopener')
        // Reflect the new record immediately.
        setCrm((c) => (c ? { ...c, records: [...c.records, { module: 'Leads', id: res.id!, name: [form.firstName, form.lastName].filter(Boolean).join(' '), company: form.company, email: form.email, phone: form.phone, url: res.url!, matchVia: 'email' }] } : c))
        setAddOpen(false)
      } else if (res.scopeError) {
        setScopeBlocked(true)
        desk.toast('Zoho is connected read-only — copy the details or reconnect with write access')
      } else {
        desk.toast(res.error || 'Could not add to Zoho')
      }
    } catch (e) {
      desk.toast(e instanceof Error ? e.message : 'Could not add to Zoho')
    } finally {
      setPushBusy(false)
    }
  }

  return (
    <>
      {people.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 12 }}>People</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {people.map((person) => (
              <div key={person.id} style={box}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{person.name}</span>
                  {person.role && (
                    <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase', color: A, background: 'rgba(18,67,59,.09)', borderRadius: 999, padding: '2px 8px' }}>
                      {person.role}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11.5, color: C.faint }}>
                    {messageCount(person.id) > 0 ? `${messageCount(person.id)} message${messageCount(person.id) === 1 ? '' : 's'} · ` : ''}
                    last seen {fmtDate(person.lastSeenAt)}
                  </span>
                </div>
                {(person.email || person.phone) && (
                  <div style={{ fontSize: 12, color: C.sub, marginTop: 5, fontFamily: mono }}>
                    {[person.email, person.phone].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {meetings.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 12 }}>Meetings</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {meetings.map((meeting) => (
              <div key={meeting.id} style={box}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 5, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: 13, minWidth: 0 }}>{meeting.title}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11.5, color: C.faint, fontFamily: mono }}>{fmtDate(meeting.startsAt)}</span>
                </div>
                {meeting.tldr && <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{meeting.tldr}</div>}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
                  <span style={{ fontSize: 11.5, color: C.faint }}>
                    {meeting.attendees.map((a) => a.name || a.email).filter(Boolean).join(', ')}
                  </span>
                  {!!meeting.url && (
                    <a href={meeting.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 600, color: A, whiteSpace: 'nowrap' }}>
                      Open dossier ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ ...upLabel, letterSpacing: '.07em', marginBottom: 0 }}>Zoho CRM</div>
          {crm?.available && (
            <button onClick={() => void lookupCrm()} disabled={crmBusy} style={{ background: 'none', border: 'none', color: C.faint, cursor: crmBusy ? 'default' : 'pointer', fontSize: 11.5, fontWeight: 600, padding: 0 }}>
              {crmBusy ? 'Checking…' : 'Re-check'}
            </button>
          )}
        </div>
        {crm === null ? (
          <button
            onClick={() => void lookupCrm()}
            disabled={crmBusy}
            style={{ fontSize: 12.5, fontWeight: 600, color: A, background: 'rgba(18,67,59,.07)', border: `1px solid rgba(18,67,59,.2)`, borderRadius: 8, padding: '8px 14px', cursor: crmBusy ? 'default' : 'pointer', opacity: crmBusy ? 0.6 : 1 }}
          >
            {crmBusy ? 'Looking up…' : 'Look up in CRM'}
          </button>
        ) : !crm.available ? (
          <div style={{ fontSize: 12.5, color: C.faint }}>Zoho isn&apos;t connected yet — the developer can add it under Settings → Platform.</div>
        ) : crm.records.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {crm.records.map((record) => (
              <div key={`${record.module}:${record.id}`} style={{ ...box, display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase', color: C.sub, background: C.bg4, borderRadius: 999, padding: '2px 8px' }}>
                  {record.module === 'Leads' ? 'Lead' : 'Contact'}
                </span>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{record.name}</span>
                {record.matchVia === 'ai' && (
                  <span title="Matched by AI keyword search" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase', color: A, background: 'rgba(18,67,59,.1)', borderRadius: 999, padding: '2px 7px' }}>
                    AI match{record.matchConfidence ? ` · ${Math.round(record.matchConfidence * 100)}%` : ''}
                  </span>
                )}
                <span style={{ fontSize: 12, color: C.sub, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{record.company}</span>
                <a href={record.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 700, color: A, whiteSpace: 'nowrap' }}>
                  Open in CRM ↗
                </a>
              </div>
            ))}
          </div>
        ) : (
          // No match — open the editable popup to add it.
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: C.faint, flex: 1, minWidth: 140 }}>No matching record in Zoho yet.</span>
            <button
              onClick={openAdd}
              style={{ fontSize: 12.5, fontWeight: 700, color: '#fff', background: A, border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              Add to CRM
            </button>
          </div>
        )}
      </div>

      {addOpen && form && (
        <AddToCrmPopup
          form={form}
          setField={setField}
          scopeBlocked={scopeBlocked}
          busy={pushBusy}
          onCreate={() => void pushToCrm()}
          onCopy={copyDetails}
          onClose={() => setAddOpen(false)}
        />
      )}
    </>
  )
}

const fieldLabel: CSSProperties = { fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.faint, marginBottom: 4, display: 'block' }
const fieldInput: CSSProperties = { width: '100%', padding: '8px 10px', border: `1px solid ${C.border2}`, borderRadius: 7, fontSize: 13, background: C.bg2, color: C.body, boxSizing: 'border-box' }

/** One text field in the popup. Module-scope so typing never loses focus. */
function CrmField({ form, setField, k, label, wide }: { form: CrmPrefill; setField: (key: keyof CrmPrefill, value: string) => void; k: keyof CrmPrefill; label: string; wide?: boolean }): ReactNode {
  return (
    <div style={{ gridColumn: wide ? '1 / -1' : undefined }}>
      <label style={fieldLabel}>{label}</label>
      <input value={form[k]} onChange={(e) => setField(k, e.target.value)} style={fieldInput} />
    </div>
  )
}

/** The editable "new Zoho lead" popup — prefilled Zoho fields you can tweak, then push via the API. */
function AddToCrmPopup({
  form, setField, scopeBlocked, busy, onCreate, onCopy, onClose,
}: {
  form: CrmPrefill
  setField: (key: keyof CrmPrefill, value: string) => void
  scopeBlocked: boolean
  busy: boolean
  onCreate: () => void
  onCopy: () => void
  onClose: () => void
}): ReactNode {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,30,28,.45)', zIndex: 60, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(560px, 100%)', background: C.bg, borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,.28)', padding: 20 }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Add to Zoho CRM</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
        </div>
        <div style={{ fontSize: 12, color: C.faint, marginBottom: 16 }}>New lead — prefilled from this lead. Edit anything, then create it in Zoho.</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <CrmField form={form} setField={setField} k="firstName" label="First name" />
          <CrmField form={form} setField={setField} k="lastName" label="Last name" />
          <CrmField form={form} setField={setField} k="company" label="Company" />
          <CrmField form={form} setField={setField} k="title" label="Title" />
          <CrmField form={form} setField={setField} k="email" label="Email" />
          <CrmField form={form} setField={setField} k="phone" label="Phone" />
          <CrmField form={form} setField={setField} k="leadSource" label="Lead source" wide />
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={fieldLabel}>Description</label>
            <textarea value={form.description} onChange={(e) => setField('description', e.target.value)} rows={5} style={{ ...fieldInput, resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }} />
          </div>
        </div>

        {scopeBlocked && (
          <div style={{ fontSize: 12, color: C.warn, background: 'rgba(181,71,8,.08)', borderRadius: 8, padding: '9px 11px', marginTop: 14 }}>
            Your Zoho connection is read-only, so Leadline can&apos;t create the record directly. Copy the details and paste them into Zoho, or ask your developer to reconnect Zoho with lead-create permission.
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 18, flexWrap: 'wrap' }}>
          <button
            onClick={onCreate}
            disabled={busy}
            style={{ fontSize: 13, fontWeight: 700, color: '#fff', background: A, border: 'none', borderRadius: 8, padding: '9px 16px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
          >
            {busy ? 'Creating…' : 'Create in Zoho'}
          </button>
          <button onClick={onCopy} style={{ fontSize: 13, fontWeight: 600, color: C.sub, background: 'none', border: `1px solid ${C.line}`, borderRadius: 8, padding: '9px 16px', cursor: 'pointer' }}>
            Copy details
          </button>
        </div>
      </div>
    </div>
  )
}
