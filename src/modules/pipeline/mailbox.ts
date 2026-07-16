import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

export interface InboundEmail {
  /** RFC 822 Message-ID — the idempotency key for the resulting lead. */
  messageId: string
  from: { name: string; address: string }
  subject: string
  date: Date
  text: string
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

/**
 * Fetch recent inbox messages over IMAP (Gmail: imap.gmail.com + app password).
 * Returns the newest `limit` messages received since `since`, parsed to plain
 * text. Read-only: nothing is marked seen, moved, or deleted.
 */
export async function fetchRecentEmails(
  config: MailboxConfig,
  since: Date,
  limit: number,
): Promise<InboundEmail[]> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: config.accessToken
      ? { user: config.user, accessToken: config.accessToken }
      : { user: config.user, pass: config.pass ?? '' },
    logger: false,
  })
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const uids = await client.search({ since })
      const recent = (Array.isArray(uids) ? uids : []).slice(-limit)
      const emails: InboundEmail[] = []
      for (const uid of recent) {
        const message = await client.fetchOne(String(uid), { source: true })
        if (!message || !('source' in message) || !message.source) continue
        const parsed = await simpleParser(message.source)
        const fromAddr = parsed.from?.value?.[0]
        emails.push({
          messageId: parsed.messageId ?? `imap:${config.user}:${uid}`,
          from: { name: fromAddr?.name ?? '', address: (fromAddr?.address ?? '').toLowerCase() },
          subject: parsed.subject ?? '(no subject)',
          date: parsed.date ?? new Date(),
          text: parsed.text?.trim() || stripHtml(typeof parsed.html === 'string' ? parsed.html : ''),
        })
      }
      return emails
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => client.close())
  }
}
