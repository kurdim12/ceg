import type { SiteFetcher } from './types'

const PAGE_TIMEOUT_MS = 8_000
const MAX_BYTES = 512 * 1024

/** Minimal robots.txt: Disallow rules in the `User-agent: *` group. */
export function parseRobots(txt: string): string[] {
  const disallows: string[] = []
  let inStarGroup = false
  for (const rawLine of txt.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line === '') continue
    const [keyRaw, ...rest] = line.split(':')
    const key = keyRaw?.trim().toLowerCase()
    const value = rest.join(':').trim()
    if (key === 'user-agent') {
      inStarGroup = value === '*'
    } else if (inStarGroup && key === 'disallow' && value !== '') {
      disallows.push(value)
    }
  }
  return disallows
}

export function isPathAllowed(disallows: string[], path: string): boolean {
  return !disallows.some((prefix) => path.startsWith(prefix))
}

/**
 * Real site fetcher: respects robots.txt, per-page timeout, size cap,
 * HTML only. Returns null on anything questionable — a missed page is a
 * `no_valid_email` lead routed to the call queue, never a crash.
 */
export function realSiteFetcher(fetcher = fetch): SiteFetcher {
  const robotsCache = new Map<string, string[]>()

  async function robotsFor(origin: string): Promise<string[]> {
    const cached = robotsCache.get(origin)
    if (cached) return cached
    let disallows: string[] = []
    try {
      const res = await fetcher(`${origin}/robots.txt`, {
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      })
      if (res.ok) disallows = parseRobots(await res.text())
    } catch {
      // No reachable robots.txt: default allow, stay polite via page caps.
    }
    robotsCache.set(origin, disallows)
    return disallows
  }

  return {
    async fetchPage(url) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return null
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null

      const disallows = await robotsFor(parsed.origin)
      if (!isPathAllowed(disallows, parsed.pathname)) return null

      try {
        const res = await fetcher(url, {
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
          headers: { Accept: 'text/html' },
        })
        if (!res.ok) return null
        const type = res.headers.get('content-type') ?? ''
        if (!type.includes('text/html')) return null
        const text = await res.text()
        return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text
      } catch {
        return null
      }
    },
  }
}

const CONTACT_LINK_RE = /href=["']([^"']*(?:contact|about|kontakt|impressum|contacto)[^"']*)["']/gi

/** Same-host contact-ish pages worth a look when the homepage has no email. */
export function contactPageUrls(html: string, baseUrl: string, limit = 2): string[] {
  const urls = new Set<string>()
  const base = new URL(baseUrl)
  for (const match of html.matchAll(CONTACT_LINK_RE)) {
    try {
      const candidate = new URL(match[1]!, base)
      if (candidate.host === base.host && candidate.href !== base.href) {
        urls.add(candidate.href)
      }
    } catch {
      // unparseable href — skip
    }
    if (urls.size >= limit) break
  }
  return [...urls]
}
