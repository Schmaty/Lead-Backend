import { ImapFlow } from 'imapflow'
import { simpleParser, type AddressObject } from 'mailparser'

export interface InboundEmail {
  /** RFC 822 Message-ID — with References/In-Reply-To, the basis of thread identity. */
  messageId: string
  from: { name: string; address: string }
  /** Recipient addresses (lowercased) — used to match sent mail back to leads. */
  to: string[]
  subject: string
  date: Date
  text: string
  /** Message-IDs from the References header, oldest (thread root) first. */
  references: string[]
  inReplyTo: string | null
}

export interface MailboxConfig {
  host: string
  port: number
  user: string
  /** App password (IMAP basic auth). Exactly one of pass / accessToken is set. */
  pass?: string
  /** OAuth access token (XOAUTH2) — the sign-in path clients use. */
  accessToken?: string
}

const stripHtml = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const addressList = (value: AddressObject | AddressObject[] | undefined): string[] => {
  const objects = Array.isArray(value) ? value : value ? [value] : []
  return objects
    .flatMap((o) => o.value ?? [])
    .map((a) => (a.address ?? '').toLowerCase())
    .filter(Boolean)
}

function connect(config: MailboxConfig): ImapFlow {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: config.accessToken
      ? { user: config.user, accessToken: config.accessToken }
      : { user: config.user, pass: config.pass ?? '' },
    logger: false,
  })
  // Gmail resets sockets after logout; an unhandled 'error' event would kill
  // the whole process. In-flight operations still reject through the API.
  client.on('error', () => {})
  return client
}

async function fetchFromMailbox(
  client: ImapFlow,
  path: string,
  config: MailboxConfig,
  since: Date,
  limit: number,
): Promise<InboundEmail[]> {
  const lock = await client.getMailboxLock(path)
  try {
    const uids = await client.search({ since })
    const recent = (Array.isArray(uids) ? uids : []).slice(0, limit) // oldest-first: partial windows resume next scan
    const emails: InboundEmail[] = []
    for (const uid of recent) {
      const message = await client.fetchOne(String(uid), { source: true })
      if (!message || !('source' in message) || !message.source) continue
      const parsed = await simpleParser(message.source)
      const fromAddr = parsed.from?.value?.[0]
      const references = (Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [])
        .map((r) => r.trim())
        .filter(Boolean)
      emails.push({
        messageId: parsed.messageId ?? `imap:${config.user}:${path}:${uid}`,
        from: { name: fromAddr?.name ?? '', address: (fromAddr?.address ?? '').toLowerCase() },
        to: addressList(parsed.to),
        subject: parsed.subject ?? '(no subject)',
        date: parsed.date ?? new Date(),
        text: parsed.text?.trim() || stripHtml(typeof parsed.html === 'string' ? parsed.html : ''),
        references,
        inReplyTo: parsed.inReplyTo?.trim() || null,
      })
    }
    return emails
  } finally {
    lock.release()
  }
}

/**
 * Fetch recent inbox messages over IMAP. Returns the newest `limit` messages
 * received since `since`, parsed to plain text with threading headers.
 * Read-only: nothing is marked seen, moved, or deleted.
 */
export async function fetchRecentEmails(
  config: MailboxConfig,
  since: Date,
  limit: number,
): Promise<InboundEmail[]> {
  const client = connect(config)
  await client.connect()
  try {
    return await fetchFromMailbox(client, 'INBOX', config, since, limit)
  } finally {
    await client.logout().catch(() => client.close())
  }
}

/**
 * Fetch recent messages from the account's sent-mail folder (found via the
 * special-use \Sent flag, with common names as fallback). Used to notice the
 * team's own replies so the lead's conversation and progress stay current.
 * Returns [] when no sent folder can be found.
 */
export async function fetchSentEmails(
  config: MailboxConfig,
  since: Date,
  limit: number,
): Promise<InboundEmail[]> {
  const client = connect(config)
  await client.connect()
  try {
    const boxes = await client.list()
    const sent =
      boxes.find((b) => b.specialUse === '\\Sent') ??
      boxes.find((b) => /sent/i.test(b.name)) ??
      null
    if (!sent) return []
    return await fetchFromMailbox(client, sent.path, config, since, limit)
  } finally {
    await client.logout().catch(() => client.close())
  }
}
