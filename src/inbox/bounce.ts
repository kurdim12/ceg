/**
 * Deterministic bounce detection, independent of the LLM triage. Real
 * delivery-status notifications arrive from mailer-daemon / postmaster — never
 * from the lead — so they never match a contact by sender. This inspects the
 * raw message for daemon senders and DSN markers, and extracts the address
 * that actually failed so the bounce can be attributed to a real outbound send.
 */

export interface BounceParse {
  isBounce: boolean
  /** The recipient that failed, lower-cased, or null if unparseable. */
  failedRecipient: string | null
}

const DAEMON_RE = /(mailer-?daemon|postmaster|mail delivery (subsystem|system))/i
const DSN_SUBJECT_RE =
  /(delivery status notification|undeliverable|delivery (has )?failed|failure notice|returned mail|mail delivery failed|message not delivered|could not be delivered|delivery incomplete)/i
const DSN_BODY_RE =
  /(final-recipient:|action:\s*failed|status:\s*5\.\d|diagnostic-code:|smtp;\s*5\d\d|\b550[ \-]|\b5\.\d\.\d\b|user unknown|no such user|does not exist|mailbox (unavailable|not found)|recipient address rejected)/i

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i

function isDaemonAddress(email: string): boolean {
  return /(mailer-?daemon|postmaster|no-?reply)/i.test(email)
}

/** Pull the failed recipient out of a DSN body, preferring structured fields. */
function extractFailedRecipient(body: string, daemonFrom: string): string | null {
  const structured = [
    /final-recipient:\s*(?:rfc822;)?\s*<?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>?/i,
    /original-recipient:\s*(?:rfc822;)?\s*<?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>?/i,
    /(?:failed recipient|recipient|to)\s*:?\s*<?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>?/i,
    /<([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>[^\n]{0,80}?(?:550|5\.\d\.\d|does not exist|user unknown|no such user)/i,
  ]
  for (const re of structured) {
    const m = body.match(re)
    if (m?.[1] && !isDaemonAddress(m[1])) return m[1].toLowerCase()
  }
  // Fallback: the first non-daemon address anywhere in the body.
  const all = body.match(new RegExp(EMAIL_RE, 'gi')) ?? []
  for (const e of all) {
    const low = e.toLowerCase()
    if (!isDaemonAddress(low) && low !== daemonFrom.toLowerCase()) return low
  }
  return null
}

export function parseBounce(inbound: {
  fromEmail: string
  subject: string
  body: string
}): BounceParse {
  const from = inbound.fromEmail ?? ''
  const subject = inbound.subject ?? ''
  const body = inbound.body ?? ''

  const looksLikeBounce =
    DAEMON_RE.test(from) || DAEMON_RE.test(subject) || DSN_SUBJECT_RE.test(subject) || DSN_BODY_RE.test(body)

  if (!looksLikeBounce) return { isBounce: false, failedRecipient: null }
  return { isBounce: true, failedRecipient: extractFailedRecipient(body, from) }
}
