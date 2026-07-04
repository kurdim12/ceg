import { getSecret } from '../settings/store'
import { placesAdapter } from './places'
import { zeroBounceAdapter } from './zerobounce'
import { realSiteFetcher } from './crawler'
import { gmailAdapterFor, tokensKey } from './gmail'
import { openRouterAdapter } from './openrouter'
import type { GmailAdapter, LlmAdapter, PlacesAdapter, SiteFetcher, VerifierAdapter } from './types'

/**
 * Keys-later contract: a real adapter activates the moment its key appears
 * in settings — zero code changes. Key absent → null → callers HOLD.
 */
export async function getVerifier(kv: KVNamespace): Promise<VerifierAdapter | null> {
  const key = await getSecret(kv, 'ZEROBOUNCE_API_KEY')
  return key ? zeroBounceAdapter(key) : null
}

export async function getPlaces(kv: KVNamespace): Promise<PlacesAdapter | null> {
  const key = await getSecret(kv, 'GOOGLE_PLACES_API_KEY')
  return key ? placesAdapter(key) : null
}

/** The crawler is keyless: real in deployment, mocked only in tests. */
export function getSiteFetcher(): SiteFetcher {
  return realSiteFetcher()
}

export async function getLlm(kv: KVNamespace): Promise<LlmAdapter | null> {
  const key = await getSecret(kv, 'OPENROUTER_API_KEY')
  return key ? openRouterAdapter(key) : null
}

/**
 * Send adapter for one owner inbox. Null (→ hold) unless BOTH the OAuth
 * client credentials are configured AND this owner completed their grant.
 */
export async function getGmailFor(
  db: D1Database,
  kv: KVNamespace,
  userId: number,
): Promise<GmailAdapter | null> {
  const [clientId, clientSecret] = await Promise.all([
    getSecret(kv, 'GMAIL_CLIENT_ID'),
    getSecret(kv, 'GMAIL_CLIENT_SECRET'),
  ])
  if (!clientId || !clientSecret) return null
  const tokens = await kv.get(tokensKey(userId))
  if (!tokens) return null
  const user = await db
    .prepare('SELECT email, gmail_connected FROM users WHERE id = ?')
    .bind(userId)
    .first<{ email: string; gmail_connected: number }>()
  if (!user || user.gmail_connected !== 1) return null
  return gmailAdapterFor(kv, userId, user.email, clientId, clientSecret)
}
