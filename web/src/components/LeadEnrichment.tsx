import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { api } from '../api'
import { fmtDate } from '../compute'
import { useDesk } from '../store'
import { A, C, mono, upLabel } from '../styles'
import type { CrmLookup, Lead, Meeting, Person } from '../types'

const box: CSSProperties = { border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 14px' }
const soonPill: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: C.warn,
  background: 'rgba(181,71,8,.09)',
  borderRadius: 999,
  padding: '3px 8px',
}

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

  useEffect(() => {
    setDetail(null)
    setCrm(null)
    let cancelled = false
    void api.getLead(lead.id).then((full) => {
      if (cancelled) return
      setDetail(full)
      // The scan already pulls the CRM — show its cached matches instantly.
      if (full.crmCheckedAt) {
        setCrm({ available: true, records: full.crmRecords ?? [], checkedAt: full.crmCheckedAt, push: { comingSoon: true } })
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
          <span style={soonPill}>Push · coming soon</span>
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
        ) : crm.records.length === 0 ? (
          <div style={{ fontSize: 12.5, color: C.faint }}>
            No matching records in Zoho for this lead&apos;s contacts.{' '}
            <button onClick={() => void lookupCrm()} disabled={crmBusy} style={{ background: 'none', border: 'none', color: A, cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: 0 }}>
              {crmBusy ? 'Checking…' : 'Re-check'}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {crm.records.map((record) => (
              <div key={`${record.module}:${record.id}`} style={{ ...box, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase', color: C.sub, background: C.bg4, borderRadius: 999, padding: '2px 8px' }}>
                  {record.module === 'Leads' ? 'Lead' : 'Contact'}
                </span>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{record.name}</span>
                <span style={{ fontSize: 12, color: C.sub, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{record.company}</span>
                <a href={record.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 600, color: A, whiteSpace: 'nowrap' }}>
                  Open in Zoho ↗
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
