import { getSecret, type SecretSource } from '../settings/store'
import { placesAdapter } from './places'
import { zeroBounceAdapter } from './zerobounce'
import { realSiteFetcher } from './crawler'
import { gmailAdapterFor, tokensKey } from './gmail'
import { openRouterAdapter } from './openrouter'
import type { GmailAdapter, LlmAdapter, PlacesAdapter, SiteFetcher, VerifierAdapter } from './types'

/**
 * Keys-later contract: a real adapter activates the moment its key appears
 * in settings (or as a Cloudflare secret) — zero code changes. Key absent
 * → null → callers HOLD.
 */
export async function getVerifier(source: SecretSource): Promise<VerifierAdapter | null> {
  const key = await getSecret(source, 'ZEROBOUNCE_API_KEY')
  return key ? zeroBounceAdapter(key) : null
}

export async function getPlaces(source: SecretSource): Promise<PlacesAdapter | null> {
  const key = await getSecret(source, 'GOOGLE_PLACES_API_KEY')
  return key ? placesAdapter(key) : null
}

/** The crawler is keyless: real in deployment, mocked only in tests. */
export function getSiteFetcher(): SiteFetcher {
  return realSiteFetcher()
}

export async function getLlm(source: SecretSource): Promise<LlmAdapter | null> {
  const key = await getSecret(source, 'OPENROUTER_API_KEY')
  return key ? openRouterAdapter(key) : null
}

/** Inbox reader for one connected owner; same holding rules as the sender. */
export async function getGmailReaderFor(
  db: D1Database,
  source: SecretSource,
  userId: number,
): Promise<import('./gmail-reader').GmailReaderAdapter | null> {
  const [clientId, clientSecret] = await Promise.all([
    getSecret(source, 'GMAIL_CLIENT_ID'),
    getSecret(source, 'GMAIL_CLIENT_SECRET'),
  ])
  if (!clientId || !clientSecret) return null
  const tokens = await source.KV.get(tokensKey(userId))
  if (!tokens) return null
  const user = await db
    .prepare('SELECT gmail_connected FROM users WHERE id = ?')
    .bind(userId)
    .first<{ gmail_connected: number }>()
  if (!user || user.gmail_connected !== 1) return null
  const { gmailReaderFor } = await import('./gmail-reader')
  return gmailReaderFor(source.KV, userId, clientId, clientSecret)
}

/**
 * Send adapter for one owner inbox. Null (→ hold) unless BOTH the OAuth
 * client credentials are configured AND this owner completed their grant.
 */
export async function getGmailFor(
  db: D1Database,
  source: SecretSource,
  userId: number,
): Promise<GmailAdapter | null> {
  const [clientId, clientSecret] = await Promise.all([
    getSecret(source, 'GMAIL_CLIENT_ID'),
    getSecret(source, 'GMAIL_CLIENT_SECRET'),
  ])
  if (!clientId || !clientSecret) return null
  const tokens = await source.KV.get(tokensKey(userId))
  if (!tokens) return null
  const user = await db
    .prepare('SELECT email, gmail_connected FROM users WHERE id = ?')
    .bind(userId)
    .first<{ email: string; gmail_connected: number }>()
  if (!user || user.gmail_connected !== 1) return null
  return gmailAdapterFor(source.KV, userId, user.email, clientId, clientSecret)
}
