import { getAccessToken } from './gmail'

export interface InboundGmailMessage {
  fromEmail: string
  subject: string
  body: string
  internalDate: number
}

export interface GmailReaderAdapter {
  /** New inbox messages since the cursor (ms epoch); returns advanced cursor. */
  listNewInbound(cursor: number | null): Promise<{
    messages: InboundGmailMessage[]
    cursor: number | null
  }>
}

function decodeB64Url(data: string): string {
  const b64 = data.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

interface GmailPayload {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPayload[]
  headers?: Array<{ name: string; value: string }>
}

export function extractPlainText(payload: GmailPayload | undefined): string {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeB64Url(payload.body.data)
  }
  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part)
    if (text) return text
  }
  return ''
}

export function parseFromHeader(value: string): string {
  const angled = /<([^>]+)>/.exec(value)
  return (angled?.[1] ?? value).trim().toLowerCase()
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
        const msgRes = await fetcher(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`,
          { headers: auth, signal: AbortSignal.timeout(20_000) },
        )
        if (!msgRes.ok) continue
        const msg = (await msgRes.json()) as { internalDate?: string; payload?: GmailPayload }
        const internalDate = Number(msg.internalDate ?? 0)
        if (cursor !== null && internalDate <= cursor) continue
        const headers = msg.payload?.headers ?? []
        const header = (name: string) =>
          headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
        messages.push({
          fromEmail: parseFromHeader(header('From')),
          subject: header('Subject'),
          body: extractPlainText(msg.payload),
          internalDate,
        })
        if (internalDate > maxDate) maxDate = internalDate
      }
      return { messages, cursor: maxDate || cursor }
    },
  }
}
