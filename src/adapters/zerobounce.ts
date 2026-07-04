import type { VerifierAdapter, VerifyOutcome } from './types'

/**
 * ZeroBounce status → our four outcomes. Anything undeliverable or risky
 * maps to invalid; catch-all and unknown are distinct because policy holds
 * them (map §5) rather than sending or discarding.
 */
export function mapZeroBounceStatus(status: string): VerifyOutcome {
  switch (status) {
    case 'valid':
      return 'valid'
    case 'catch-all':
      return 'catch_all'
    case 'unknown':
      return 'unknown'
    default:
      // invalid, spamtrap, abuse, do_not_mail
      return 'invalid'
  }
}

export function zeroBounceAdapter(apiKey: string, fetcher = fetch): VerifierAdapter {
  return {
    async verify(email) {
      const url = new URL('https://api.zerobounce.net/v2/validate')
      url.searchParams.set('api_key', apiKey)
      url.searchParams.set('email', email)
      const res = await fetcher(url.toString(), { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) {
        // Verification failure is not a verdict: treat as unknown → held.
        return 'unknown'
      }
      const body = (await res.json()) as { status?: string }
      return mapZeroBounceStatus(body.status ?? 'unknown')
    },
  }
}
