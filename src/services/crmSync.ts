import type Anthropic from '@anthropic-ai/sdk'
import type { PrismaClient } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import { aiMatchCrm } from './crmMatch.js'
import type { ZohoConfig } from './platformCredentials.js'
import { searchCrmByEmails, type CrmRecord } from './zoho.js'

export interface SyncLeadCrmOptions {
  /** When set, an exact-email miss escalates to a cheap AI keyword search. */
  anthropic?: Anthropic
}

/**
 * Pull the CRM's view of one lead and fold it back in (read-only toward Zoho):
 * caches the matches on the lead, logs a `crm_match` timeline event for each
 * record seen for the first time, fills an empty org from the CRM company,
 * and fills empty person phone numbers. Runs on every scan and on the
 * drawer's refresh button. Exact email search first; if it finds nothing and
 * an Anthropic client is supplied, a cheap AI keyword search tries to match.
 */
export async function syncLeadCrm(
  prisma: PrismaClient,
  zoho: ZohoConfig,
  leadId: string,
  options: SyncLeadCrmOptions = {},
): Promise<{ records: CrmRecord[]; newMatches: number }> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { people: true },
  })
  if (!lead) return { records: [], newMatches: 0 }

  const emails = [lead.email, ...lead.people.map((person) => person.email)].filter(Boolean)
  let records = await searchCrmByEmails(zoho, emails)

  // Nothing on the exact email? Let the cheap model try keyword variations.
  if (records.length === 0 && options.anthropic) {
    records = await aiMatchCrm(options.anthropic, zoho, {
      name: lead.name,
      email: lead.email,
      org: lead.org,
      summary: lead.summary,
      people: lead.people.map((p) => ({ name: p.name, email: p.email })),
    })
  }

  const known = new Set(
    ((lead.crmRecords ?? []) as Array<{ module?: string; id?: string }>).map((r) => `${r.module}:${r.id}`),
  )
  const fresh = records.filter((record) => !known.has(`${record.module}:${record.id}`))

  await prisma.$transaction([
    prisma.lead.update({
      where: { id: lead.id },
      data: {
        crmRecords: records as unknown as Prisma.InputJsonValue,
        crmCheckedAt: new Date(),
        ...(lead.org === '' && records[0]?.company ? { org: records[0].company } : {}),
      },
    }),
    ...fresh.map((record) =>
      prisma.timelineEvent.create({
        data: {
          leadId: lead.id,
          type: 'crm_match',
          actor: 'system',
          detail:
            record.matchVia === 'ai'
              ? `Matched in Zoho CRM via AI keyword search${record.matchConfidence ? ` (${Math.round(record.matchConfidence * 100)}%)` : ''}: ${record.name}${record.company ? ` — ${record.company}` : ''} (${record.module})`
              : `Found in Zoho CRM: ${record.name}${record.company ? ` — ${record.company}` : ''} (${record.module})`,
        },
      }),
    ),
  ])

  // A CRM record often carries the phone number email threads never do.
  for (const record of records) {
    if (!record.phone || !record.email) continue
    const person = lead.people.find((p) => p.email.toLowerCase() === record.email.toLowerCase() && !p.phone)
    if (person) {
      await prisma.person.update({ where: { id: person.id }, data: { phone: record.phone } })
    }
  }

  return { records, newMatches: fresh.length }
}
