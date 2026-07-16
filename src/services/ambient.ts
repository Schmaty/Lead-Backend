import type { AmbientConfig } from './platformCredentials.js'

/**
 * Ambient (ambient.us) meeting API. Verified live: Bearer auth;
 * GET /meetings?limit=&cursor= pages the calendar newest-first;
 * GET /meetings/:id?include=attendees,insights expands attendee emails and
 * insight references; GET /insights/:id?include=text_content,json_content
 * returns the AI meeting dossier (markdown text + {tldr, ...} json).
 */

export interface AmbientAttendee {
  email: string
  name: string
  organizer: boolean
}

export interface AmbientMeeting {
  id: string
  title: string
  startsAt: Date
  endsAt: Date | null
  attendees: AmbientAttendee[]
  /** Dashboard link for the meeting's dossier, when one exists. */
  insightId: string | null
  insightUrl: string
}

export interface AmbientInsight {
  tldr: string
  text: string
}

interface RawMeeting {
  id: string
  title?: string
  starts_at?: string
  ends_at?: string
  attendees?: Array<{ email?: string; display_name?: string; is_organizer?: boolean }>
  insights?: Array<{ id?: string; type?: string; result?: string; url?: string }>
}

export interface AmbientDeps {
  fetchJson(url: string, headers: Record<string, string>): Promise<{ status: number; json: unknown }>
}

let deps: AmbientDeps = {
  async fetchJson(url, headers) {
    const res = await fetch(url, { headers })
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json }
  },
}

/** Test hook: swap the Ambient network edge for a fake. Returns a restore fn. */
export function setAmbientDepsForTesting(fake: AmbientDeps): () => void {
  const previous = deps
  deps = fake
  return () => {
    deps = previous
  }
}

async function get(config: AmbientConfig, path: string): Promise<unknown> {
  const { status, json } = await deps.fetchJson(`${config.baseUrl}${path}`, {
    Authorization: `Bearer ${config.apiKey}`,
  })
  if (status !== 200) throw new Error(`Ambient API ${path.split('?')[0]} failed (HTTP ${status})`)
  return json
}

function parseMeeting(raw: RawMeeting): AmbientMeeting {
  const dossier = (raw.insights ?? []).find((i) => i.type === 'meeting_dossier' && i.result === 'ok')
  return {
    id: raw.id,
    title: raw.title ?? '(untitled meeting)',
    startsAt: raw.starts_at ? new Date(raw.starts_at) : new Date(0),
    endsAt: raw.ends_at ? new Date(raw.ends_at) : null,
    attendees: (raw.attendees ?? [])
      .map((a) => ({
        email: (a.email ?? '').toLowerCase(),
        name: a.display_name && a.display_name !== a.email ? a.display_name : '',
        organizer: a.is_organizer === true,
      }))
      .filter((a) => a.email),
    insightId: dossier?.id ?? null,
    insightUrl: dossier?.url ?? '',
  }
}

/**
 * Meetings that already happened within [since, now], with attendees and
 * insight references expanded. The list endpoint pages newest-first (and
 * includes future calendar events, which are skipped); paging stops once
 * entries fall before `since`.
 */
export async function listPastMeetings(config: AmbientConfig, since: Date, limit = 25): Promise<AmbientMeeting[]> {
  const now = new Date()
  const matches: AmbientMeeting[] = []
  let cursor: string | null = null
  for (let page = 0; page < 10 && matches.length < limit; page++) {
    const path: string = `/meetings?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const body = (await get(config, path)) as { data?: RawMeeting[]; next_cursor?: string | null }
    const rows = body.data ?? []
    if (rows.length === 0) break
    let sawOlder = false
    for (const row of rows) {
      const startsAt = row.starts_at ? new Date(row.starts_at) : null
      if (!startsAt) continue
      if (startsAt > now) continue // future calendar entry
      if (startsAt < since) {
        sawOlder = true
        continue
      }
      const detail = (await get(config, `/meetings/${row.id}?include=attendees,insights`)) as RawMeeting
      matches.push(parseMeeting(detail))
      if (matches.length >= limit) break
    }
    if (sawOlder || !body.next_cursor) break
    cursor = body.next_cursor
  }
  return matches
}

/** The AI dossier content for one insight reference. */
export async function getInsight(config: AmbientConfig, insightId: string): Promise<AmbientInsight> {
  const body = (await get(config, `/insights/${insightId}?include=text_content,json_content`)) as {
    text_content?: string | null
    json_content?: { tldr?: string } | null
  }
  return {
    tldr: body.json_content?.tldr ?? '',
    text: body.text_content ?? '',
  }
}
