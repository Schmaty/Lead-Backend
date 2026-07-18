import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { api } from '../api'
import { fmtDate } from '../compute'
import { useDesk } from '../store'
import { A, C, mono, upLabel } from '../styles'
import type { CrmLookup, Lead, Meeting, Person } from '../types'

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

  // Everything the new-CRM-record form is prefilled with.
  const prefill = detail ?? lead
  const dealValue = prefill.estPayoutRaw || (prefill.dealValueHigh ? `$${prefill.dealValueLow.toLocaleString()}–$${prefill.dealValueHigh.toLocaleString()}` : '—')
  const prefillPhone = (detail?.people ?? []).find((p) => p.phone)?.phone ?? ''
  const prefillRows: Array<[string, string]> = [
    ['Name', prefill.name || '—'],
    ['Email', prefill.email || '—'],
    ['Company', prefill.org || '—'],
    ['Phone', prefillPhone || '—'],
    ['Est. value', dealValue],
    ['Inquiry', prefill.inquiryType || '—'],
    ['Summary', prefill.summary || '—'],
  ]

  const openZohoForm = (): void => {
    window.open(crm?.createUrl ?? 'https://crm.zoho.com/crm/tab/Leads/create', '_blank', 'noopener')
  }

  const copyDetails = (): void => {
    const text = prefillRows.map(([k, v]) => `${k}: ${v}`).join('\n')
    navigator.clipboard?.writeText(text).then(
      () => desk.toast('Lead details copied — paste into Zoho'),
      () => desk.toast('Could not copy'),
    )
  }

  const pushToCrm = async (): Promise<void> => {
    setPushBusy(true)
    try {
      const res = await api.crmPush(lead.id)
      if (res.ok && res.url) {
        desk.toast('Added to Zoho CRM ✓')
        window.open(res.url, '_blank', 'noopener')
        // Reflect the new record immediately.
        setCrm((c) => (c ? { ...c, records: [...c.records, { module: 'Leads', id: res.id!, name: prefill.name, company: prefill.org, email: prefill.email, phone: prefillPhone, url: res.url!, matchVia: 'email' }] } : c))
        setAddOpen(false)
      } else if (res.scopeError) {
        setScopeBlocked(true)
        desk.toast('Zoho is connected read-only — use the prefilled form below')
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
          // No match — offer to add it, prefilled.
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, color: C.faint, flex: 1, minWidth: 140 }}>No matching record in Zoho yet.</span>
              <button
                onClick={() => setAddOpen((o) => !o)}
                style={{ fontSize: 12.5, fontWeight: 700, color: '#fff', background: A, border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                {addOpen ? 'Close' : 'Add to CRM'}
              </button>
            </div>
            {addOpen && (
              <div style={{ ...box, marginTop: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: C.faint, marginBottom: 8 }}>New Zoho lead — prefilled</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {prefillRows.map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 8, fontSize: 12.5, lineHeight: 1.4 }}>
                      <span style={{ color: C.faint, minWidth: 78, flex: '0 0 auto' }}>{k}</span>
                      <span style={{ color: C.sub, minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
                    </div>
                  ))}
                </div>
                {scopeBlocked && (
                  <div style={{ fontSize: 11.5, color: C.warn, background: 'rgba(181,71,8,.08)', borderRadius: 7, padding: '7px 9px', marginTop: 9 }}>
                    Your Zoho connection is read-only, so I can&apos;t create the record directly. Open the prefilled Zoho form and paste the details, or ask your developer to reconnect Zoho with lead-create permission.
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11, flexWrap: 'wrap' }}>
                  {!scopeBlocked && (
                    <button
                      onClick={() => void pushToCrm()}
                      disabled={pushBusy}
                      style={{ fontSize: 12.5, fontWeight: 700, color: '#fff', background: A, border: 'none', borderRadius: 8, padding: '8px 14px', cursor: pushBusy ? 'default' : 'pointer', opacity: pushBusy ? 0.6 : 1 }}
                    >
                      {pushBusy ? 'Adding…' : 'Create in Zoho'}
                    </button>
                  )}
                  <button onClick={openZohoForm} style={{ fontSize: 12.5, fontWeight: 600, color: A, background: 'rgba(18,67,59,.07)', border: `1px solid rgba(18,67,59,.2)`, borderRadius: 8, padding: '8px 14px', cursor: 'pointer' }}>
                    Open Zoho form ↗
                  </button>
                  <button onClick={copyDetails} style={{ fontSize: 12.5, fontWeight: 600, color: C.sub, background: 'none', border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 14px', cursor: 'pointer' }}>
                    Copy details
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
