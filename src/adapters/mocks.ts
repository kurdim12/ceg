import type {
  GmailAdapter,
  LlmAdapter,
  PlacesAdapter,
  SiteFetcher,
  SourcedBusiness,
  VerifierAdapter,
  VerifyOutcome,
} from './types'

/** Test fixtures only — deployed code never falls back to these (rule 2). */

export function mockPlaces(results: SourcedBusiness[]): PlacesAdapter {
  return {
    async searchBusinesses({ count }) {
      return results.slice(0, count)
    },
  }
}

export function mockVerifier(outcomes: Record<string, VerifyOutcome>): VerifierAdapter {
  return {
    async verify(email) {
      return outcomes[email.toLowerCase()] ?? 'unknown'
    },
  }
}

export function mockSiteFetcher(pages: Record<string, string>): SiteFetcher {
  return {
    async fetchPage(url) {
      return pages[url] ?? null
    },
  }
}

export function mockLlm(reply: string | ((prompt: string) => string)): LlmAdapter {
  return {
    async complete({ prompt }) {
      return typeof reply === 'function' ? reply(prompt) : reply
    },
  }
}

export function mockGmail(sent: Array<{ to: string; subject: string; body: string }>): GmailAdapter {
  let n = 0
  return {
    async send({ to, subject, body }) {
      sent.push({ to, subject, body })
      return { providerMessageId: `mock-${++n}` }
    },
  }
}
