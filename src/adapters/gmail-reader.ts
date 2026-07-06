import { getAccessToken } from './gmail'
import { inboundParser, type ParsedDsn } from './inbound'

export interface InboundGmailMessage {
  fromEmail: string
  subject: string
  body: string
  internalDate: number
  /** Structured delivery-status, present only for real bounces. */
  dsn: ParsedDsn | null
}

export interface GmailReaderAdapter {
  /** New inbox messages since the cursor (ms epoch); returns advanced cursor. */
  listNewInbound(cursor: number | null): Promise<{
    messages: InboundGmailMessage[]
    cursor: number | null
  }>
}

/** base64url (Gmail's raw format) → bytes for the MIME parser. */
function b64UrlToBytes(data: string): Uint8Array {
  const b64 = data.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(b64)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

export function gmailReaderFor(
  kv: KVNamespace,
  userId: number,
  clientId: string,
  clientSecret: string,
  fetcher: typeof fetch = fetch,
): GmailReaderAdapter {
  return {
    async listNewInbound(cursor) {
      const token = await getAccessToken(kv, userId, clientId, clientSecret, new Date(), fetcher)
      const auth = { Authorization: `Bearer ${token}` }
      // First poll starts a day back; later polls resume from the cursor.
      const afterSec = Math.floor((cursor ?? Date.now() - 24 * 3600 * 1000) / 1000)

      const listRes = await fetcher(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(
          `in:inbox after:${afterSec}`,
        )}&maxResults=20`,
        { headers: auth, signal: AbortSignal.timeout(20_000) },
      )
      if (!listRes.ok) throw new Error(`gmail list failed: ${listRes.status}`)
      const list = (await listRes.json()) as { messages?: Array<{ id: string }> }

      const messages: InboundGmailMessage[] = []
      let maxDate = cursor ?? 0
      for (const ref of list.messages ?? []) {
        // format=raw gives the full RFC822 message so postal-mime can parse
        // multipart bodies and the message/delivery-status part of bounces.
        const msgRes = await fetcher(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=raw`,
          { headers: auth, signal: AbortSignal.timeout(20_000) },
        )
        if (!msgRes.ok) continue
        const msg = (await msgRes.json()) as { internalDate?: string; raw?: string }
        const internalDate = Number(msg.internalDate ?? 0)
        if (cursor !== null && internalDate <= cursor) continue
        if (!msg.raw) continue
        const parsed = await inboundParser.parse(b64UrlToBytes(msg.raw))
        messages.push({
          fromEmail: parsed.fromEmail,
          subject: parsed.subject,
          body: parsed.text,
          internalDate,
          dsn: parsed.dsn,
        })
        if (internalDate > maxDate) maxDate = internalDate
      }
      return { messages, cursor: maxDate || cursor }
    },
  }
}
