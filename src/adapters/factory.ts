import { getSecret } from '../settings/store'
import { placesAdapter } from './places'
import { zeroBounceAdapter } from './zerobounce'
import { realSiteFetcher } from './crawler'
import type { PlacesAdapter, SiteFetcher, VerifierAdapter } from './types'

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
