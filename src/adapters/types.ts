/**
 * Run directive rule 1: every external service sits behind an interface.
 * Real adapters activate only when their key appears in settings; with a
 * key unset the subsystem HOLDS (fail-safe, never fake). Mocks implement
 * these same interfaces and are injected explicitly in tests.
 */

export interface SourcedBusiness {
  name: string
  website: string | null
  phone: string | null
  address: string | null
  city: string
  country: string | null
}

export interface PlacesAdapter {
  searchBusinesses(params: {
    geo: string
    businessType: string
    count: number
  }): Promise<SourcedBusiness[]>
}

export type VerifyOutcome = 'valid' | 'invalid' | 'catch_all' | 'unknown'

export interface VerifierAdapter {
  verify(email: string): Promise<VerifyOutcome>
}

export interface SiteFetcher {
  /** Returns page HTML, or null when unreachable/disallowed. */
  fetchPage(url: string): Promise<string | null>
}

export interface LlmAdapter {
  complete(args: { system: string; prompt: string; maxTokens?: number }): Promise<string>
}

export interface GmailAdapter {
  /** Sends from a connected owner inbox; only the sequence engine calls this. */
  send(args: {
    fromUserId: number
    to: string
    subject: string
    body: string
  }): Promise<{ providerMessageId: string }>
}
