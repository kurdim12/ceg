import type { GmailAdapter } from './types'

export interface GmailTokens {
  refresh_token: string
  access_token?: string
  access_expires_at?: string
  email?: string
}

export function tokensKey(userId: number): string {
  return `gmail:tokens:${userId}`
}

/** RFC 2822 plain-text message, base64url-encoded for the Gmail API. */
export function buildRawMessage(args: {
  from: string
  to: string
  subject: string
  body: string
}): string {
  const message = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    args.body,
  ].join('\r\n')
  const bytes = new TextEncoder().encode(message)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function gmailAuthUrl(args: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set(
    'scope',
    [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
  )
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', args.state)
  return url.toString()
}

async function refreshAccessToken(
  tokens: GmailTokens,
  clientId: string,
  clientSecret: string,
  fetcher: typeof fetch,
): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`gmail token refresh failed: ${res.status}`)
  return (await res.json()) as { access_token: string; expires_in: number }
}

/** Shared by the send adapter and the inbox reader. */
export async function getAccessToken(
  kv: KVNamespace,
  userId: number,
  clientId: string,
  clientSecret: string,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const raw = await kv.get(tokensKey(userId))
  if (!raw) throw new Error(`no gmail tokens for user ${userId}`)
  const tokens = JSON.parse(raw) as GmailTokens
  if (
    tokens.access_token &&
    tokens.access_expires_at &&
    new Date(tokens.access_expires_at).getTime() - 60_000 > now.getTime()
  ) {
    return tokens.access_token
  }
  const refreshed = await refreshAccessToken(tokens, clientId, clientSecret, fetcher)
  const next: GmailTokens = {
    ...tokens,
    access_token: refreshed.access_token,
    access_expires_at: new Date(now.getTime() + refreshed.expires_in * 1000).toISOString(),
  }
  await kv.put(tokensKey(userId), JSON.stringify(next))
  return refreshed.access_token
}

/**
 * Gmail send adapter for one connected owner inbox. Only the sequence
 * engine holds a reference to this — the agent has no send tool at all.
 */
export function gmailAdapterFor(
  kv: KVNamespace,
  userId: number,
  fromEmail: string,
  clientId: string,
  clientSecret: string,
  fetcher: typeof fetch = fetch,
): GmailAdapter {
  const accessToken = (now: Date) =>
    getAccessToken(kv, userId, clientId, clientSecret, now, fetcher)

  return {
    async send({ to, subject, body }) {
      const token = await accessToken(new Date())
      const res = await fetcher(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ raw: buildRawMessage({ from: fromEmail, to, subject, body }) }),
          signal: AbortSignal.timeout(20_000),
        },
      )
      if (!res.ok) throw new Error(`gmail send failed: ${res.status}`)
      const data = (await res.json()) as { id: string }
      return { providerMessageId: data.id }
    },
  }
}
