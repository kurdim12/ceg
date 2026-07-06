import PostalMime from 'postal-mime'

/**
 * Inbound email parsing behind a thin adapter. postal-mime (MIT-0) turns raw
 * RFC822 into structured fields — correctly handling multipart, encodings, and
 * (crucially) the `message/delivery-status` part of a bounce, which a naive
 * body walk drops. Same house rule: never throws in normal use; on a parse
 * failure it returns best-effort empty fields rather than exploding a poll.
 */

export interface ParsedDsn {
  finalRecipient: string | null
  action: string | null
  status: string | null
}

export interface ParsedInbound {
  fromEmail: string
  subject: string
  text: string
  /** Structured delivery-status, present only for real DSN bounces. */
  dsn: ParsedDsn | null
}

export interface InboundParser {
  parse(raw: string | ArrayBuffer | Uint8Array): Promise<ParsedInbound>
}

function stripHtml(html: string | undefined): string {
  if (!html) return ''
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Pull Final-Recipient / Action / Status out of a message/delivery-status part. */
function parseDeliveryStatus(text: string): ParsedDsn {
  const final = /Final-Recipient:\s*(?:rfc822;)?\s*<?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>?/i.exec(text)
  const action = /Action:\s*([a-z]+)/i.exec(text)
  const status = /Status:\s*(\d\.\d+\.\d+)/i.exec(text)
  return {
    finalRecipient: final?.[1]?.toLowerCase() ?? null,
    action: action?.[1]?.toLowerCase() ?? null,
    status: status?.[1] ?? null,
  }
}

export const inboundParser: InboundParser = {
  async parse(raw) {
    const email = await PostalMime.parse(raw).catch(() => null)
    if (!email) return { fromEmail: '', subject: '', text: '', dsn: null }
    const fromEmail = (email.from?.address ?? '').toLowerCase()
    const subject = email.subject ?? ''
    const text = (email.text ?? '').trim() || stripHtml(email.html)

    // A bounce carries a message/delivery-status part; parse it if present.
    let dsn: ParsedDsn | null = null
    for (const att of email.attachments ?? []) {
      if (att.mimeType?.toLowerCase() === 'message/delivery-status') {
        const body = typeof att.content === 'string' ? att.content : new TextDecoder().decode(att.content)
        dsn = parseDeliveryStatus(body)
        break
      }
    }
    return { fromEmail, subject, text, dsn }
  },
}
